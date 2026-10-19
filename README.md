# Communication Hub

Multi-tenant notification service for **email, SMS and push**. Built on NestJS 12
(Fastify), PostgreSQL (TypeORM) and Redis (BullMQ), with the same layout and
response conventions as the `backend` service.

| Channel | Providers (`*_PROVIDER`) |
| --- | --- |
| Email | `smtp` (nodemailer, pooled) · `ses` (AWS SES v2) · `sendgrid` · `console` |
| SMS | `twilio` · `sns` (AWS SNS) · `console` |
| Push | `fcm` (Firebase Cloud Messaging: Android, iOS, web) · `console` |

`console` logs messages instead of sending, so everything runs locally without
vendor credentials.

## Architecture

```
client ─► API (Fastify) ─► Postgres (notifications row, status=queued)
                       └─► Redis/BullMQ: one queue per channel ─► workers ─► provider
                                                                     │
                                       status + attempt log ◄────────┘
```

- **Async by design.** `POST /notifications` validates, stores and enqueues, then
  returns `202`. Vendor latency and outages never block callers.
- **Postgres is the source of truth.** A job only carries the notification id.
  Redis keeps finished jobs briefly, so its memory stays flat.
- **One queue per channel.** A slow SMS vendor can't delay email. Concurrency
  and a cluster-wide rate limit are configurable per channel (`EMAIL_RATE_MAX`, …).
- **Scale API and workers independently.** The same image runs with
  `APP_ROLE=api` (stateless, scale on RPS) or `APP_ROLE=worker` (scale on queue
  depth, see `/api/health/ready`).

### Reliability

| Concern | How it's handled |
| --- | --- |
| Client retries / double submits | `Idempotency-Key` header (or `idempotencyKey` field), unique per tenant. A repeat, even 10 concurrent ones, returns the original row with `Idempotent-Replayed: true` and sends nothing |
| Vendor hiccups | Retries with exponential backoff and jitter (`QUEUE_ATTEMPTS`, `QUEUE_BACKOFF_MS`), so retries after an outage don't all hit the vendor at once |
| Campaign vs. OTP | Priorities per channel queue: `high` jumps everything queued. Bulk sends default to `low` and single sends to `normal`, so a running campaign never delays an OTP |
| Errors retrying can't fix | Providers raise `PermanentDeliveryError` (invalid number, unsubscribed, dead token, …) and the notification fails immediately, without burning retries |
| Crash / Redis blip between DB write and enqueue | The row is committed first and the request still succeeds. The sweeper (every minute, once cluster-wide) enqueues rows idle longer than `QUEUE_STUCK_AFTER_MINUTES` (default 2), so delivery happens within ~3 minutes, never twice |
| Worker crash mid-job | BullMQ stalled-job recovery; workers claim rows with a conditional update, so redelivery is harmless |
| Cancel vs. worker race | Status changes are conditional (`WHERE status IN …`) |
| Dead push tokens | Deactivated automatically when FCM reports them |
| Redis down | API-key lookups fall back to Postgres; the rate limiter fails open |
| Deploys | Graceful shutdown: in-flight jobs finish and connections close on SIGTERM |
| Audit | Every attempt is stored in `notification_attempts` (provider, error, duration) |

Delivery is **at-least-once**: if the vendor accepted a message but the process
died before recording it, it will be sent again.

## Getting started

Requirements: Node.js **22.12+** (`nvm use`), PostgreSQL **13+**, Redis **6.2+**.

```bash
nvm use
npm ci
cp .env.example .env          # set DB_PASSWORD and ADMIN_API_KEY
createdb communication_hub
npm run start:dev             # runs migrations, starts API + workers
```

Or the full stack in Docker: `docker compose up --build`.

- API: http://localhost:3000/api
- Swagger UI: http://localhost:3000/docs (OpenAPI JSON at `/docs/json`)
- Health: `/api/health` (liveness), `/api/health/ready` (Postgres + Redis + queue depth)

With `BOOTSTRAP_TENANT_*` set (see `.env.example`), a tenant with a known API key
is created on startup, so you can call the API right away.

## Environments & secrets

`APP_ENV` selects the deployment environment, using the same names as the backend
service: `local`, `development`, `staging`, `preprod` or `production`.

| APP_ENV | Configuration source |
| --- | --- |
| `local` | `.env` (copy `.env.example`) |
| `development`, `staging`, `preprod`, `production` | AWS Secrets Manager secret `communication-hub/<APP_ENV>-env` (override the name with `AWS_SECRET_NAME`) |

The secret is a JSON object holding the same variables as `.env.example`:

```json
{ "DB_HOST": "...", "DB_PASSWORD": "...", "REDIS_HOST": "...", "ADMIN_API_KEY": "...",
  "EMAIL_PROVIDER": "ses", "SMS_PROVIDER": "twilio", "TWILIO_AUTH_TOKEN": "...",
  "PUSH_PROVIDER": "fcm", "FIREBASE_SERVICE_ACCOUNT": { "type": "service_account", "...": "..." } }
```

- Same wiring as the backend: `app.module.ts` registers
  `ConfigModule.forRoot({ load: [environment] })`. `config/environment.ts` reads the
  secret with `fetchSecrets()` (`utils/secretManager.ts`, `AWS_SECRET_MANAGER` in
  `constant.ts`), copies it into `process.env`, validates, and returns the typed
  config. Secret values override `.env` and container variables. Every module reads
  configuration through `ConfigService`, so it always sees the final values.
- Set these on the **container**, not in the secret. They choose the secret and the
  process's role, and API and worker deployments share one secret: `APP_ENV`,
  `APP_ROLE`, `AWS_REGION` (if not `us-east-1`), `AWS_SECRET_NAME` (optional) and
  `BODY_LIMIT_BYTES` (optional).
- AWS credentials come from the pod/instance role (IRSA). The role needs
  `secretsmanager:GetSecretValue` on the secret.
- If the secret can't be loaded, the process exits with an error naming the
  environment and the secret. It never starts with partial configuration.
- Outside `local`, startup also requires `ADMIN_API_KEY` and real providers
  (`console` is rejected).
- Nested JSON values, such as a Firebase service account object, are passed on
  as JSON strings.
- The TypeORM CLI (`npm run migration:*`) loads configuration the same way.

## Authentication

| Header | For | Notes |
| --- | --- | --- |
| `x-api-key` | All tenant routes (default) | Per-tenant keys, SHA-256 hashed at rest, cached in Redis, revocable instantly |
| `x-admin-key` | `/api/v1/admin/*` | `ADMIN_API_KEY`; admin routes are disabled when unset |

Routes are protected by default. Opt out with `@Public()` or switch to admin
access with `@AdminOnly()` (`src/decorator/auth.decorator.ts`). Each tenant is
rate-limited across all routes (`THROTTLE_LIMIT` per `THROTTLE_TTL_SECONDS`),
with counters shared through Redis.

## API

Every response uses the backend's envelope:

```json
{ "statusCode": 202, "type": "NOTIFICATION_ACCEPTED", "message": "Notification accepted for delivery", "data": { } }
```

`message` is translated from `type` via `src/i18n/<lang>/messages.json` (send a
`language` header). Responses carry an `x-request-id`; send your own to trace a
request across services.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/v1/notifications` | Send one notification |
| POST | `/api/v1/notifications/bulk` | Send up to 500 |
| GET | `/api/v1/notifications` | List (cursor pagination; filter by status, channel, recipient, userId) |
| GET | `/api/v1/notifications/:id` | Details + delivery attempts |
| POST | `/api/v1/notifications/:id/retry` | Retry a failed notification |
| POST | `/api/v1/notifications/:id/cancel` | Cancel a queued/scheduled/retrying one |
| POST / GET / DELETE | `/api/v1/devices` | Register / list / remove push tokens |
| POST / GET / PATCH | `/api/v1/admin/tenants[/:id]` | Manage tenants (branding, active flag) |
| POST / GET / DELETE | `/api/v1/admin/tenants/:id/api-keys[/:keyId]` | Issue, list, revoke keys |

### Examples

```bash
KEY='x-api-key: chk_local_dev_key_change_me'

# Login OTP: high priority, safe to retry (same Idempotency-Key = never sent twice)
curl -X POST localhost:3000/api/v1/notifications -H 'content-type: application/json' -H "$KEY" \
  -H 'Idempotency-Key: 6f1c2a9e-otp-login-42' -d '{
  "channel": "email", "recipient": "jane@example.com", "priority": "high",
  "subject": "Your code is {{code}}", "template": "otp",
  "data": { "name": "Jane", "code": "123456" }
}'

# SMS, scheduled
curl -X POST localhost:3000/api/v1/notifications -H 'content-type: application/json' -H "$KEY" -d '{
  "channel": "sms", "recipient": "+14155550123", "body": "Your appointment is tomorrow",
  "scheduledAt": "2026-12-01T09:00:00Z"
}'

# Push to every device of a user (register the token from the app first)
curl -X POST localhost:3000/api/v1/devices -H 'content-type: application/json' -H "$KEY" \
  -d '{ "userId": "user-42", "token": "<fcm token>", "platform": "android" }'
curl -X POST localhost:3000/api/v1/notifications -H 'content-type: application/json' -H "$KEY" -d '{
  "channel": "push", "userId": "user-42", "subject": "Order shipped",
  "body": "Your order {{orderId}} is on its way", "data": { "orderId": "123" },
  "metadata": { "deeplink": "app://orders/123" }
}'
```

## Templates

Handlebars files per channel; `template` is the file name without extension:

```
src/views/
  email/<name>.html    full HTML email ({{values}} are HTML-escaped)
  sms/<name>.txt
  push/<name>.txt      push body (title comes from `subject`)
```

Adding a template means adding a file; no code changes. Every template gets
`appName` (tenant's `settings.appName`, else `APP_NAME`) and `year`, and values
in `data` override them. `subject` and `body` support `{{placeholders}}` too.
Unknown templates and broken placeholders are rejected with `400` before
anything is stored.

## Database

Schema changes go through migrations only (`synchronize` is off). The API
process applies pending migrations on startup; workers never migrate.

| Table | Purpose |
| --- | --- |
| `tenants` | White-label clients, branding/sender settings, active flag |
| `api_keys` | Hashed keys per tenant (rotation, expiry, revocation, last use) |
| `notifications` | One row per message; status `queued → processing → sent / retrying / failed / cancelled` |
| `notification_attempts` | Audit log of every delivery attempt |
| `device_tokens` | Push tokens per tenant user |

To change the schema, edit a model in `src/models`, run
`npm run migration:generate -- src/database/postgres/migrations/<name>`, then add
the class to `src/database/postgres/migrations/index.ts`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run start:dev` | Watch mode (API + workers) |
| `npm run build` / `start:prod` | Compile and run (`APP_ROLE` decides the role) |
| `npm run start:api` / `start:worker` | Run a single role from `dist/` |
| `npm test` | Unit tests |
| `npm run test:e2e` | E2E against real Postgres + Redis (`createdb communication_hub_test`), including `delivery-guarantees.e2e-spec.ts` (idempotency, priority, retries, crash recovery) |
| `npm run migration:show` / `:run` / `:revert` / `:generate` | Migrations |
| `npm run lint` / `format` | oxlint / prettier |

## Project structure

Mirrors the `backend` service:

```
src/
  main.ts                 entry: loads env + secrets, then starts API or worker (APP_ROLE)
  app.module.ts           config, logging, i18n, throttling, infra, features, global guards
  app.setup.ts            Fastify adapter, helmet, CORS, versioning, validation (shared with e2e)
  auth/                   AuthGuard (tenant/admin/public), per-tenant ThrottlerGuard
  bootstrap/              startup tasks: sweeper schedule, bootstrap tenant
  common/dtos/            pagination DTOs
  config/                 typed config, env validation, environment.ts (.env + Secrets Manager)
  constant/               enums, queue names, limits, headers
  database/postgres/      connection, CLI data source, migrations
  decorator/              @ResponseMessage, @CurrentTenant, @Public, @AdminOnly, @ApiEnvelope
  dto/                    request/response DTOs
  exceptions/             AppException + global filter
  i18n/                   response messages per language
  models/                 TypeORM entities
  modules/
    notification/         controller, service, repositories, queue producer,
                          dispatcher (worker logic), processors, sweeper
    device/               push token registry
    tenant/               tenants, API keys (admin API)
    health/
  response/               SUCCESS/ERROR types, response envelope interceptor
  swagger/
  utils/
    channel/              provider contracts, PermanentDeliveryError, console provider
    email/  sms/  firebase/   channel services + vendor providers
    queue/  redis/        BullMQ setup, Redis client, Redis throttler storage
    template/             Handlebars renderer
  validator/              channel-aware validation rules
  views/                  templates per channel
```

## Production checklist

- `NODE_ENV=production`, a strong `ADMIN_API_KEY`, `SWAGGER_ENABLED=false` (or `SWAGGER_USER/PASS`)
- Run `APP_ROLE=api` and `APP_ROLE=worker` as separate deployments. Liveness probe
  `/api/health`, readiness probe `/api/health/ready`. Workers have no HTTP port,
  so use a process-based liveness check for them.
- Redis: persistence on (AOF) and `maxmemory-policy noeviction` (BullMQ requirement)
- Verify sender domains/numbers with your providers; set per-channel `*_RATE_MAX` to vendor limits
- Prefer IAM roles for SES/SNS over static keys
