# Communication Hub

Multi-tenant notification service for **email, SMS and push**. Other services call one
**gRPC API** (contract in [`proto/`](proto/communication_hub/v1)), and the hub stores,
queues and delivers each message through the **tenant's own providers**, with retries,
failover, idempotency, encryption at rest and a full delivery log.

An HTTP/JSON gateway with **Swagger UI** exposes the same API to REST clients and for
trying things out in the browser.

Built on NestJS 12 (gRPC transport), PostgreSQL (TypeORM) and Redis (BullMQ), monitored with
Prometheus + Loki + Grafana. Design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Channel | Providers (per tenant in the DB, or the platform default from `.env`) |
| --- | --- |
| Email | `smtp` (any SMTP server) · `ses` (Amazon SES) · `sendgrid` · `console` |
| SMS | `twilio` · `sns` (Amazon SNS) · `console` |
| Push | `fcm` (Firebase Cloud Messaging: Android, iOS, web) · `console` |
| In-app | the user's **inbox** (`InboxService`), devices signalled through the push providers (FCM) |

`console` prints the message to the server log instead of sending it, so everything
runs locally without vendor credentials. It's rejected as platform default outside `APP_ENV=local`.

**Contents**
1. [Quick start](#1-quick-start)
2. [The gRPC API](#2-the-grpc-api): services, metadata, errors
3. [Getting an API key](#3-getting-an-api-key)
4. [Sending a notification](#4-sending-a-notification): email, SMS, push, bulk
   - [In-app notifications (inbox + push)](#in-app-notifications-inbox--push)
5. [Templates (stored in the database, versioned)](#5-templates)
6. [Senders (several per channel, rules)](#6-senders)
7. [Providers per tenant (DB + cache, failover)](#7-providers-per-tenant)
8. [Encryption of recipient data](#8-encryption-of-recipient-data)
9. [How sending works](#9-how-sending-works)
10. [Logging and monitoring (Grafana, Loki, Prometheus)](#10-logging-and-monitoring)
11. [Environment variables](#11-environment-variables)
12. [Environments & AWS Secrets Manager](#12-environments--aws-secrets-manager)
13. [Reliability](#13-reliability)
14. [Testing failures](#14-testing-failures)
15. [Database](#15-database)
16. [Scripts, project structure, production checklist](#16-scripts)

---

## 1. Quick start

Requirements: **Node.js 22.12+** (`nvm use`), **PostgreSQL 13+**, **Redis 6.2+**.

```bash
nvm use
npm ci
cp .env.example .env          # set DB_PASSWORD, and the encryption keys:
echo "ENCRYPTION_KEYS=k1:$(openssl rand -base64 32)" >> .env
echo "BLIND_INDEX_KEY=$(openssl rand -base64 32)"    >> .env
createdb communication_hub    # must be an EMPTY database
npm run start:dev             # runs migrations, starts the gRPC API + workers
```

Or run the whole stack, monitoring included, in Docker: `docker compose up --build`.

| What | Where |
| --- | --- |
| gRPC API | `localhost:50051` (server reflection on locally: `grpcurl -plaintext localhost:50051 list`) |
| **Swagger UI** (try every method) | http://localhost:3000/docs (OpenAPI JSON at `/docs/openapi.json`) |
| HTTP/JSON API | `POST http://localhost:3000/api/v1/<Service>/<Method>` |
| Liveness / readiness | http://localhost:9464/health/live, http://localhost:9464/health/ready |
| Prometheus metrics | http://localhost:9464/metrics |
| Grafana (compose) | http://localhost:3001 (admin / admin), dashboard **Communication Hub** |

On startup every connection logs its state (one JSON line each; pretty in development):

```
Environment  APP_ENV=local: using .env and process environment
Redis        Connected to localhost:6379/0 (cache, rate limits, API keys)
PostgreSQL   Connected to localhost:5432/communication_hub (..., 2 migrations applied, latest TemplatesSendersProviders1762000000000)
BullMQ       Connected to localhost:6379/0; queues: notifications-email, notifications-sms, notifications-push, maintenance
EmailProcessor  Worker started, consuming "notifications-email" (concurrency 20, rate limit 100 per 1000ms)
Ops          Ops endpoints on :9464 (/health/live, /health/ready, /metrics)
Bootstrap    Communication Hub (all, local) serving gRPC on :50051 (reflection on)
```

The app **refuses to start** without `ENCRYPTION_KEYS` / `BLIND_INDEX_KEY` (recipients are
never stored in clear), naming what is missing.

---

## 2. The gRPC API

| Service (`communication_hub.v1.*`) | Credentials | Purpose |
| --- | --- | --- |
| `NotificationService` | tenant `x-api-key` | send (single / bulk), get, list, retry, cancel |
| `TemplateService` | tenant | create, version, activate / roll back, archive, preview templates |
| `SenderService` | tenant | sender identities and sender rules |
| `DeviceService` | tenant | push token registry |
| `InboxService` | tenant | in-app inbox: list, unread count, mark read, delete |
| `TenantAdminService` | admin `x-admin-key` | tenants, API keys |
| `ProviderAdminService` | admin | per-tenant provider configs and credentials |
| `grpc.health.v1.Health` | none | standard health check (Kubernetes gRPC probes) |

**Metadata** (gRPC headers): `x-api-key` or `x-admin-key` (required), `x-request-id` (optional,
written to every log line of the call *and* of the worker that delivers the message),
`language` (error message language).

**Conventions:** proto enums are prefixed (`CHANNEL_EMAIL`, `PRIORITY_HIGH`, ...); `optional`
fields have presence (unset = not given); template values are a `google.protobuf.Struct`;
times are `google.protobuf.Timestamp`. Generate clients from `proto/` with `buf` / `protoc`
in any language.

**Errors** are standard gRPC status codes. The machine-readable reason is in the
`error-type` trailing metadata (JSON context, e.g. per-field validation errors, in `error-data`):

| gRPC code | `error-type` examples |
| --- | --- |
| `INVALID_ARGUMENT` | `VALIDATION_ERROR` (details names the field), `TEMPLATE_INVALID`, `TEMPLATE_RENDER_FAILED`, `PROVIDER_CONFIG_INVALID` |
| `UNAUTHENTICATED` | `API_KEY_MISSING`, `API_KEY_INVALID`, `ADMIN_KEY_INVALID` |
| `PERMISSION_DENIED` | `TENANT_INACTIVE`, `ADMIN_DISABLED` |
| `NOT_FOUND` | `NOTIFICATION_NOT_FOUND`, `TEMPLATE_NOT_FOUND`, `TEMPLATE_VERSION_NOT_FOUND`, `SENDER_NOT_FOUND`, ... |
| `ALREADY_EXISTS` | `TENANT_SLUG_TAKEN`, `TEMPLATE_NAME_TAKEN`, `SENDER_VALUE_TAKEN`, `PROVIDER_NAME_TAKEN` |
| `FAILED_PRECONDITION` | `NOTIFICATION_NOT_RETRYABLE`, `NOTIFICATION_NOT_CANCELLABLE`, `TEMPLATE_ARCHIVED` |
| `RESOURCE_EXHAUSTED` | `TOO_MANY_REQUESTS` (per-tenant rate limit; `retryAfterSeconds` in `error-data`) |
| `UNAVAILABLE` / `INTERNAL` | infrastructure problems (logged server-side, never leaked) |

Rejected calls store nothing. Delivery problems are not RPC errors: they show up as
`NOTIFICATION_STATUS_FAILED` with `error` and the attempt log on the notification.

### HTTP/JSON and Swagger

Every RPC is also available as `POST /api/v1/<Service>/<Method>` on `HTTP_PORT` (3000), with a
JSON body in the proto3 JSON format (enum names, RFC 3339 times, `data` as a plain object).
Open **http://localhost:3000/docs**, click *Authorize*, paste the `x-api-key` (or `x-admin-key`)
and use *Try it out* on any method.

```bash
curl -X POST http://localhost:3000/api/v1/NotificationService/SendNotification \
  -H 'Content-Type: application/json' -H 'x-api-key: <API_KEY>' \
  -d '{ "notification": { "channel": "CHANNEL_SMS", "recipient": "+919876543210", "template": "otp", "data": { "code": "482913" } } }'
```

- The OpenAPI document is **generated from `proto/` at startup** (descriptions from the proto
  comments), so it always matches the gRPC contract.
- The gateway forwards to the local gRPC server: same auth, rate limits, validation, errors,
  logs and metrics. It is not a second implementation.
- Errors: HTTP status mapped from the gRPC code (400, 401, 403, 404, 409, 429, 503, ...) with
  the body `{ "code", "type", "message", "data" }`; `x-request-id` is echoed.
- Swagger is on by default only locally (`SWAGGER_ENABLED`); `SWAGGER_USER` / `SWAGGER_PASS`
  add basic auth. `HTTP_PORT=0` turns the gateway off.

---

## 3. Getting an API key

**Locally (simplest):** `.env` defines a bootstrap tenant created at startup
(`BOOTSTRAP_TENANT_SLUG`, `BOOTSTRAP_TENANT_API_KEY`); use that key as `x-api-key`.

**For a new tenant** (any environment), with `ADMIN_API_KEY`:

```bash
grpcurl -plaintext -H 'x-admin-key: <ADMIN_API_KEY>' \
  -d '{ "name": "My Backend", "slug": "my-backend", "settings": { "appName": "Acme" } }' \
  localhost:50051 communication_hub.v1.TenantAdminService/CreateTenant
```

The response contains `apiKey.key`, **shown only once** (only a hash is stored). New tenants
also get the starter templates (`otp`, `welcome` for every channel). More keys for rotation:
`CreateApiKey`; revoke with `RevokeApiKey` (immediate).

---

## 4. Sending a notification

All channels use `NotificationService/SendNotification` (or `SendBulkNotifications`, up to 500):

```bash
grpcurl -plaintext -H 'x-api-key: <API_KEY>' -H 'x-request-id: signup-42' -d '{
  "notification": {
    "channel": "CHANNEL_EMAIL",
    "recipient": "jane@example.com",
    "template": "welcome",
    "data": { "name": "Jane", "actionUrl": "https://example.com/start" },
    "priority": "PRIORITY_HIGH",
    "idempotencyKey": "welcome-user-42"
  }
}' localhost:50051 communication_hub.v1.NotificationService/SendNotification
```

The response is the stored notification (`NOTIFICATION_STATUS_QUEUED`, `templateVersion` pinned)
and `replayed`. **Delivery is asynchronous**: read the outcome with `GetNotification` (status,
provider, provider message id, every attempt incl. sender and failovers).

| Channel | `recipient` | Content |
| --- | --- | --- |
| Email | email address | `template`, or `subject` + `body`; an inline `subject` overrides the template's |
| SMS | **E.164** (`+919876543210`) | `template` or `body`; no `subject` |
| Push | device token, **or** `userId` (all devices of the user, max 50) | `template` or `body`; `subject` = title; `metadata` = FCM data payload |

Other fields: `templateVersion` (pin a version), `senderId` (choose the sender, [section 6](#6-senders)),
`data` (template values: stored encrypted), `metadata` (your references), `priority`
(default `NORMAL` single / `LOW` bulk, use `HIGH` for OTPs), `scheduledAt` (up to 30 days),
`idempotencyKey` (a repeated key returns the original, `replayed: true`, nothing sent twice).
Every template also receives `appName` (tenant brand, else `APP_NAME`) and `year`.

Push devices: `DeviceService/RegisterDevice` `{ "userId": "user-42", "token": "<FCM token>", "platform": "DEVICE_PLATFORM_ANDROID" }`.
Dead tokens reported by FCM are deactivated automatically.

Cancel before delivery with `CancelNotification` (queued / scheduled / retrying); resend a
failed one with `RetryNotification`. List with `ListNotifications` (filters `status`, `channel`,
`recipient` (exact, via the blind index), `userId`; cursor pagination).

### In-app notifications (inbox + push)

`CHANNEL_IN_APP` delivers into the user's **inbox** inside your app, through its own queue
(`notifications-in-app`) with the same priorities, retries, idempotency and crash recovery
as every channel:

```bash
grpcurl -plaintext -H 'x-api-key: <API_KEY>' -d '{
  "notification": {
    "channel": "CHANNEL_IN_APP", "userId": "user-42",
    "subject": "Order shipped", "body": "Order {{orderId}} is on its way",
    "data": { "orderId": "ORD-1042" }, "metadata": { "deeplink": "app://orders/1042" },
    "alsoPush": true
  }
}' localhost:50051 communication_hub.v1.NotificationService/SendNotification
```

```
 SendNotification(CHANNEL_IN_APP) ─► Postgres (queued) ─► queue notifications-in-app
                                                               │ worker
   1 render (template / subject + body)                        ▼
   2 INSERT inbox_messages (once per notification) ──► status SENT, provider "inbox"
   3 FCM to the user's active devices, via the tenant's push providers (failover):
       default          silent data message {type:"inbox", inboxMessageId, notificationId, unreadCount, ...metadata}
                        → an open app refreshes its inbox and badge
       alsoPush: true   visible push (title + body) as well → "inbox + push" from one send
```

- The **inbox row is the delivery**: if the FCM signal fails (no devices, FCM down) the
  message is still in the inbox and the notification stays `SENT`; the app shows it on its
  next sync. Signal outcomes are metrics (`chub_inbox_signals_total`) and logs (`inbox_signal_failed`).
- A retried or re-enqueued job never creates a second inbox item (unique per notification).
- Read the inbox from your backend on behalf of the signed-in user (never ship the tenant
  API key in an app): `InboxService/ListInboxMessages` (`unreadOnly`, cursor pagination,
  returns `unreadCount`), `GetUnreadCount`, `MarkInboxMessagesRead` (up to 500 ids),
  `MarkAllInboxMessagesRead`, `DeleteInboxMessage`.
- Messages expire after `INBOX_RETENTION_DAYS` (90): hidden immediately, deleted by the hourly
  `purge-inbox` maintenance job in batches.
- `userId` is required, `recipient` is not used; templates work as for push (`subject` = title).
  New tenants get a starter `welcome` in-app template.

App side (FCM): handle `data.type == "inbox"` in the foreground message handler (refresh the
inbox / badge from `unreadCount`); on iOS silent messages need *Background Modes → Remote
notifications*.

### Status lifecycle

```
QUEUED ──► PROCESSING ──► SENT
              │
              ├─► RETRYING ──► PROCESSING ──► …   (all providers failed transiently, attempts left)
              └─► FAILED                          (permanent error, or attempts used up)
QUEUED / RETRYING ──► CANCELLED                   (CancelNotification)
FAILED ──► QUEUED                                 (RetryNotification)
```

---

## 5. Templates

Templates live in the **database**, owned by the tenant, managed through `TemplateService`
without deployments. A template is `(channel, name)`; its content lives in **immutable
versions**, and exactly one version is active.

```bash
# create (version 1, active)
grpcurl ... -d '{ "channel": "CHANNEL_EMAIL", "name": "password-reset",
  "content": { "subject": "Reset your {{appName}} password", "html": "<p>Hi {{name}}, <a href=\"{{url}}\">reset</a></p>" } }' \
  localhost:50051 communication_hub.v1.TemplateService/CreateTemplate

# publish v2 (or stage it with "activate": false and activate later)
... TemplateService/CreateTemplateVersion   { "templateId": "...", "content": { ... }, "activate": true }
# roll back
... TemplateService/ActivateTemplateVersion { "templateId": "...", "version": 1 }
# render with sample data, nothing sent
... TemplateService/PreviewTemplate         { "templateId": "...", "data": { "name": "Jane" } }
```

| Rule | Detail |
| --- | --- |
| Content | email: `subject` + `html` and/or `body` (text part); SMS: `body`; push: `body` (+ optional `subject` = title) |
| Validation | channel rules and a full Handlebars compile **before** storing: a broken template can't be published |
| Escaping | `{{values}}` are HTML-escaped in `html`; never in subject / SMS / push |
| Pinning | the version is resolved when a send is **accepted** and stored on the notification, so retries render identical content even if a new version is published meanwhile |
| Caching | name → active version in Redis (`TEMPLATE_CACHE_TTL_SECONDS`, dropped on every change); versions are immutable and cached for a day; compiled templates are kept in an in-process LRU |
| Archive | `ArchiveTemplate`: rejected for new sends (`TEMPLATE_ARCHIVED`), already queued ones still deliver |

Starter templates (`otp`: `code`, `name`, `expiresInMinutes`; `welcome`: `name`, `actionUrl`)
are copied from `src/views/` into every new tenant; after that they are ordinary DB templates.

---

## 6. Senders

A template no longer has one fixed `emailFrom` / `smsFrom`. Each tenant registers **any
number of senders** per channel (`SenderService/CreateSender`): email addresses
(`"Acme Support <support@acme.com>"`) and SMS sender ids / numbers (`"+14155550100"`,
`"ACME"`). For each notification the worker picks:

1. `senderId` from the request, if given (validated at accept time; if it is deactivated
   before delivery the notification fails instead of silently using another sender);
2. the first matching **sender rule**: rules for the notification's template first, then
   general rules, each by ascending `priority`:

   | Match | Example |
   | --- | --- |
   | `SENDER_RULE_MATCH_RECIPIENT_PREFIX` | `+91` → the DLT-registered Indian sender id |
   | `SENDER_RULE_MATCH_RECIPIENT_DOMAIN` | `gmail.com` → a dedicated From address |
   | `SENDER_RULE_MATCH_ANY` (+ `templateId`) | "invoices send from billing@" |

3. the tenant's **default** sender for the channel (one per channel, `isDefault`);
4. otherwise the provider's own default (`MAIL_FROM` for the platform email provider, a
   Twilio Messaging Service, ...).

A sender can be **pinned to a provider config** (`providerConfigId`), e.g. a number that only
exists in one Twilio account: that provider is then tried first. The sender used is recorded
on every attempt. Senders must be verified with the provider (SES identity, Twilio number,
DLT registration); the hub does not verify ownership. Existing `settings.emailFrom` /
`smsFrom` values were migrated to default senders.

---

## 7. Providers per tenant

Provider selection is data, not code. `ProviderAdminService` stores per tenant and channel
any number of **provider configs**: provider kind, settings, **encrypted credentials** and
`priority`:

```bash
grpcurl -plaintext -H 'x-admin-key: <ADMIN_API_KEY>' -d '{
  "tenantId": "<tenant>", "channel": "CHANNEL_SMS", "provider": "twilio", "name": "twilio-main", "priority": 1,
  "settings": { "messaging_service_sid": "MG..." },
  "credentials": { "account_sid": "AC...", "auth_token": "..." }
}' localhost:50051 communication_hub.v1.ProviderAdminService/CreateProviderConfig
```

| Provider | `settings` | `credentials` |
| --- | --- | --- |
| `smtp` | `host`*, `port`, `secure` | `user`, `pass` |
| `ses` | `region`* | `access_key_id`, `secret_access_key` (optional: IAM role) |
| `sendgrid` | | `api_key`* |
| `twilio` | `from`, `messaging_service_sid` | `account_sid`*, `auth_token`* |
| `sns` | `region`*, `sender_id` | `access_key_id`, `secret_access_key` (optional) |
| `fcm` | | `service_account`* (JSON) |
| `console` | | |

(* required; configs are validated per kind before they are stored; credentials are never
returned, only `credentialKeys`.)

**At send time** the worker reads the tenant's active configs from **Redis**
(`providers:<tenant>:<channel>`, `PROVIDER_CACHE_TTL_SECONDS`), falling back to Postgres when
the key is missing or Redis is down, and to the **platform default** (`EMAIL_PROVIDER`,
`SMS_PROVIDER`, `PUSH_PROVIDER` in `.env`) when the tenant has none. Every admin change deletes
the cache key, so it applies to the **next message**, on every worker, without a restart.

**Failover:** providers are tried in `priority` order. A transient error (timeout, 5xx,
connection refused, a client that can't be built) moves on to the next provider within
the same attempt; a permanent error (invalid number, rejected content) stops, since
another vendor would reject it too. When all fail, the job is retried with backoff.

Clients (SMTP pools, Firebase apps, SDK clients) are created once per config version and
reused; a changed config gets a new client and the old one is closed.

---

## 8. Encryption of recipient data

| Data | At rest |
| --- | --- |
| `notifications.recipient` (email, phone, device token) | AES-256-GCM |
| `notifications.data` (template values: names, OTP codes, ...) | AES-256-GCM |
| `provider_configs.credentials` | AES-256-GCM (also stays ciphertext in the Redis cache) |
| `notifications.recipient_hash` | HMAC-SHA256 blind index, scoped per tenant, for lookups |

- Ciphertext format `enc:v1:<keyId>:<iv|tag|data>`; each value is bound to its column
  (GCM additional data), so ciphertexts can't be swapped between columns.
- Encryption is transparent: TypeORM column transformers encrypt on write and decrypt on
  read, so no code path can forget it. Reads through the API return plaintext to the owning tenant.
- **Key rotation:** add a key (`ENCRYPTION_KEYS=k1:...,k2:...`), set `ENCRYPTION_ACTIVE_KEY=k2`;
  new data uses `k2`, old data still decrypts with `k1`. Re-encrypt old rows, then drop `k1`.
  `BLIND_INDEX_KEY` is separate and should not change (lookups would miss until re-indexed).
- Logs never contain recipients (masked: `j***@example.com`, `+1415*****23`), credentials or data.
- The migration encrypted existing rows in place (batched); `migration:revert` decrypts them.

---

## 9. How sending works

```
 Client ── gRPC SendNotification (x-api-key, x-request-id) ──►
 ┌─────────────────────────── API (milliseconds) ────────────────────────────┐
 │ 1 RpcContextGuard   request id, RPC name, start time (logs + metrics)       │
 │ 2 AuthGuard         API key → tenant (Redis cache, Postgres fallback)       │
 │ 3 RateLimitGuard    per-tenant budget, counted in Redis                     │
 │ 4 Controller        proto → DTO, validation per channel                     │
 │ 5 Service           template → pinned version, sender check, placeholders   │
 │ 6 Postgres          INSERT … ON CONFLICT DO NOTHING  (recipient/data encrypted) │
 │ 7 Redis / BullMQ    job { notificationId, requestId } → "notifications-<channel>" │
 └───────────────────────────── response: QUEUED ──────────────────────────────┘
                                     ▼   worker takes the job (high priority first)
 ┌──────────────────────── Worker (background) ───────────────────────────────┐
 │ 8  Claim      queued → processing, attempts + 1 (skips if already sent)     │
 │ 9  Render     pinned template version + inline text, tenant branding        │
 │ 10 Sender     request → rule → tenant default   (SenderResolver, cached)    │
 │ 11 Providers  tenant configs by priority → platform default (cached)        │
 │ 12 Send       provider 1 → (transient) provider 2 → …                       │
 │ 13 Record     sent / retrying / failed, one attempt row per provider call,  │
 │               one structured log line, Prometheus counters                  │
 └─────────────────────────────────────────────────────────────────────────────┘
```

| Step | Code |
| --- | --- |
| 1–3 | `src/grpc/rpc-context.ts`, `src/auth/auth.guard.ts`, `src/auth/rate-limit.guard.ts` |
| 4 | `src/modules/notification/notification.controller.ts`, `src/grpc/codecs.ts`, `src/dto/` |
| 5–7 | `notification.service.ts`, `notification.repository.ts`, `notification.queue.ts` |
| 8–13 | `notification.processor.ts` → `notification.dispatcher.ts` → `modules/sender/`, `modules/provider/`, `src/utils/<email\|sms\|firebase>/` |

**Error classification** (per provider): SMTP `5xx` / rejected envelope, SES `MessageRejected`,
SendGrid `4xx` (not 429), Twilio 21211/21214/21408/21610/21612/21614/21617, SNS invalid
parameter / opted out, FCM invalid payload are **permanent** (fail now). Everything else
(timeouts, 4xx SMTP, 429, 5xx, network) is **transient** (fail over, then retry with backoff).

> **Gmail SMTP note:** Gmail replaces the From address with the logged-in account unless it is
> a verified *Send mail as* alias, so sender identities don't apply; use SES or SendGrid with
> verified domains for per-tenant senders. Gmail also caps sending at ~500 emails/day.

---

## 10. Logging and monitoring

Three signals, all set up by `docker compose up` (configuration in `observability/`):

| Signal | Source | Stack |
| --- | --- | --- |
| **Logs** | one JSON line per event on stdout (pino) | Promtail → **Loki** → Grafana |
| **Metrics** | `GET :9464/metrics` on every process (api **and** worker) | **Prometheus** → Grafana, alert rules |
| **Health** | `:9464/health/live`, `:9464/health/ready`, `grpc.health.v1.Health` | Kubernetes probes |

**Logs.** Every line carries `service`, `role`, `env`, and inside a call or job `requestId`,
`rpc`, `tenantId`. Delivery outcomes are events with `notificationId`, `channel`, `provider`,
`providerConfigId`, `attempt`, `durationMs`, `error`:

| `event` | Meaning |
| --- | --- |
| `rpc` | one per gRPC call (`code`, `durationMs`) |
| `delivery_sent` / `delivery_retry` / `delivery_failed` | outcome of an attempt |
| `provider_failover` | a provider failed transiently, the next one is tried |
| `sweeper_requeued` | stuck notifications recovered |

```logql
{compose_service="worker"} | json | event="delivery_failed"                 # failures with reasons
{compose_service=~"api|worker"} | json | requestId="signup-42"               # one request, API → worker
{compose_service="worker"} | json | notificationId="<id>"                    # one message's history
```

Loki labels are low-cardinality (`compose_service`, `level`, `event`, `channel`); ids are
filtered with `| json`.

**Metrics** (no tenant/recipient labels, to keep cardinality bounded):

| Metric | Labels |
| --- | --- |
| `chub_notifications_accepted_total`, `chub_notifications_replayed_total` | channel, priority |
| `chub_notifications_finished_total` | channel, status (sent / failed) |
| `chub_delivery_attempts_total` | channel, provider, outcome (success / transient_error / permanent_error) |
| `chub_delivery_duration_seconds` (histogram) | channel, provider |
| `chub_delivery_retries_total`, `chub_provider_failovers_total` | channel, (from_provider) |
| `chub_queue_jobs` (gauge, read from BullMQ at scrape) | queue, state (waiting / active / delayed / failed) |
| `chub_sweeper_requeued_total` | |
| `chub_inbox_signals_total`, `chub_inbox_purged_total` | outcome (silent / visible / no_devices / failed) |
| `chub_grpc_requests_total`, `chub_grpc_request_duration_seconds` | method, code |
| `chub_process_*`, `chub_nodejs_*` | Node.js runtime defaults |

**Grafana** (http://localhost:3001): dashboard *Communication Hub* with overview stats, delivery
by channel/provider/outcome, latency, retries, failovers, queue health, gRPC traffic, runtime,
and Loki panels for failures and errors. **Alerts** (`observability/prometheus/alerts.yml`):
failure ratio > 5%, sustained failovers / retries, slow providers, queue backlog, failed jobs
growing, sweeper recoveries, targets down, no workers, gRPC server errors. Add an
Alertmanager to route them.

---

## 11. Environment variables

All variables are listed in `.env.example` and validated at startup
(`src/config/env.validation.ts`); the app refuses to start on invalid configuration.

| Group | Variables |
| --- | --- |
| Environment | `APP_ENV` (`local` \| `development` \| `staging` \| `preprod` \| `production`), `AWS_SECRET_NAME` |
| App | `NODE_ENV`, `APP_ROLE` (`api` \| `worker` \| `all`), `APP_NAME`, `LOG_LEVEL` |
| gRPC / ops | `GRPC_PORT` (50051), `GRPC_MAX_MESSAGE_BYTES`, `GRPC_REFLECTION` (default on locally only), `OPS_PORT` (9464, 0 = off) |
| HTTP gateway / Swagger | `HTTP_PORT` (3000, 0 = off), `BODY_LIMIT_BYTES`, `SWAGGER_ENABLED` (default on locally only), `SWAGGER_PATH`, `SWAGGER_USER`, `SWAGGER_PASS` |
| Encryption | `ENCRYPTION_KEYS` (required), `ENCRYPTION_ACTIVE_KEY`, `BLIND_INDEX_KEY` (required) |
| Caches | `PROVIDER_CACHE_TTL_SECONDS`, `SENDER_CACHE_TTL_SECONDS`, `TEMPLATE_CACHE_TTL_SECONDS` (300), `API_KEY_CACHE_TTL_SECONDS` (60) |
| Auth & limits | `ADMIN_API_KEY` (≥ 32 chars; required outside local), `THROTTLE_LIMIT`, `THROTTLE_TTL_SECONDS` |
| Bootstrap tenant | `BOOTSTRAP_TENANT_NAME`, `BOOTSTRAP_TENANT_SLUG`, `BOOTSTRAP_TENANT_API_KEY` |
| PostgreSQL | `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` (required), `DB_NAME`, `DB_SSL`, `DB_LOGGING`, `DB_POOL_SIZE` |
| Redis | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_TLS`, `REDIS_CLUSTER`, `REDIS_KEY_PREFIX` |
| Queue | `QUEUE_ATTEMPTS` (5), `QUEUE_BACKOFF_MS` (5000), `QUEUE_STUCK_AFTER_MINUTES` (2), `EMAIL_/SMS_/PUSH_/IN_APP_` + `WORKER_CONCURRENCY`, `RATE_MAX`, `RATE_DURATION_MS` |
| In-app | `INBOX_RETENTION_DAYS` (90) |
| Platform default providers | `EMAIL_PROVIDER`, `MAIL_FROM`, `SMTP_*`, `SENDGRID_API_KEY`, `SMS_PROVIDER`, `TWILIO_*`, `SNS_SENDER_ID`, `PUSH_PROVIDER`, `FIREBASE_SERVICE_ACCOUNT` |
| AWS | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (leave empty to use the IAM role) |
| Observability | `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` (optional, NestJS Observe) |

---

## 12. Environments & AWS Secrets Manager

| `APP_ENV` | Configuration source |
| --- | --- |
| `local` | `.env` |
| `development`, `staging`, `preprod`, `production` | AWS Secrets Manager secret `communication-hub/<APP_ENV>-env` (override with `AWS_SECRET_NAME`) |

The secret is a JSON object with the same variables as `.env.example`, **including
`ENCRYPTION_KEYS` and `BLIND_INDEX_KEY`** (different per environment):

```json
{ "DB_HOST": "...", "DB_PASSWORD": "...", "REDIS_HOST": "...", "ADMIN_API_KEY": "...",
  "ENCRYPTION_KEYS": "k1:...", "BLIND_INDEX_KEY": "...",
  "EMAIL_PROVIDER": "ses", "SMS_PROVIDER": "twilio", "TWILIO_AUTH_TOKEN": "...",
  "PUSH_PROVIDER": "fcm", "FIREBASE_SERVICE_ACCOUNT": { "type": "service_account", "...": "..." } }
```

- `app.module.ts` registers `ConfigModule.forRoot({ load: [environment] })`;
  `src/config/environment.ts` calls `fetchSecrets()` (`src/utils/secretManager.ts`), copies the
  secret into `process.env`, validates, and returns the typed config every module reads.
  Secret values override `.env` and container variables.
- **Set on the container, not in the secret** (read before it loads): `APP_ENV`, `APP_ROLE`,
  `AWS_REGION`, `AWS_SECRET_NAME`.
- Credentials come from the pod/instance role (IRSA) with `secretsmanager:GetSecretValue`.
- Fail fast: if the secret can't be loaded, the process exits naming it. Outside `local`,
  `ADMIN_API_KEY` and real platform providers are also required.
- The TypeORM CLI (`npm run migration:*`) loads configuration (and the cipher) the same way.

---

## 13. Reliability

| Concern | How it's handled |
| --- | --- |
| Client retries / double submits | `idempotencyKey`, unique per tenant (database unique index). Repeats, even 10 concurrent ones, return the original with `replayed: true` and send nothing |
| A vendor is down | **Failover** to the tenant's next provider within the attempt, then retries with exponential backoff and jitter (`QUEUE_ATTEMPTS`, `QUEUE_BACKOFF_MS`) |
| Errors retrying can't fix | `PermanentDeliveryError`: failed at once, no failover, no retries |
| Template changed mid-flight | The version is pinned at accept time; retries render the same content |
| Configuration changes | Provider / sender / template caches are deleted on change (next message sees it); TTLs bound staleness if an invalidation is lost |
| Campaign vs. OTP | One queue per channel with priorities: `HIGH` jumps everything queued; bulk defaults to `LOW` |
| Crash between DB write and queue push | The row is committed first and the call still succeeds. The **sweeper** (`maintenance` queue, every 60 s, once cluster-wide) re-queues idle in-flight rows, so delivery happens within ~3 minutes, never twice |
| Worker crash mid-job | BullMQ stalled-job recovery; workers claim rows with a conditional update, so redelivery never resends a sent message |
| Redis down | API keys, providers, senders and templates fall back to Postgres; the rate limiter fails open; connections recover on their own |
| Deploys (SIGTERM) | gRPC graceful shutdown; `worker-lifecycle.ts` lets in-flight sends finish and record their result before connections close (15 s force-close, 25 s process deadline) |
| Audit | Every provider call is a `notification_attempts` row (provider, sender, error, duration) |

Delivery is **at-least-once**: if a provider accepted a message but the process died before
recording it, it will be sent again.

**Scaling:** the same image runs as `APP_ROLE=api` (stateless gRPC, scale on request rate) or
`APP_ROLE=worker` (scale on `chub_queue_jobs{state="waiting"}`).

---

## 14. Testing failures

The easiest way is a broken provider config for a test tenant, no restarts needed:

```bash
# Transient: SMTP refuses connections → retrying ×4 → failed after 5 attempts
... ProviderAdminService/CreateProviderConfig '{ "tenantId": "...", "channel": "CHANNEL_EMAIL",
    "provider": "smtp", "name": "down", "priority": 1, "settings": { "host": "127.0.0.1", "port": "1" } }'
# Failover: add a second config ("provider": "console", "priority": 2): the next email fails
# over within the same attempt; GetNotification shows both provider calls.
```

A push to a `userId` with no registered devices fails permanently (no setup needed); register
a device and call `RetryNotification` to resend. Watch it all in Grafana (Loki panel
*Delivery failures*) or with SQL:

```sql
SELECT id, status, attempts, provider, error FROM notifications WHERE status = 'failed';
SELECT attempt, provider, sender, success, permanent, error, duration_ms FROM notification_attempts WHERE notification_id = '<id>';
```

Automated suites: `npm test` (unit) and `npm run test:e2e` (real Postgres + Redis over gRPC:
`app`, `http-gateway` (Swagger + JSON transcoding), `in-app` (inbox delivery, signals, read state, purge), `delivery-guarantees` (idempotency, priority, retries, crash recovery), `tenant-config`
(template versioning, sender rules, provider failover and cache invalidation, encryption,
health), `base-repository`).

---

## 15. Database

Schema changes go through migrations only (`synchronize` is off). The API process applies
pending migrations on startup; workers never migrate. Start from an **empty** database.

| Table | Purpose |
| --- | --- |
| `tenants` | Clients, branding, active flag |
| `api_keys` | Hashed keys per tenant (rotation, expiry, revocation, last use) |
| `templates` / `template_versions` | Named templates per tenant and channel; immutable versions, one active |
| `sender_identities` / `sender_rules` | Senders per tenant and channel (one default), selection rules |
| `provider_configs` | Provider kind, settings, encrypted credentials, priority per tenant and channel |
| `notifications` | One row per message: encrypted recipient + data, blind index, pinned template version, status, provider |
| `notification_attempts` | One row per provider call (sender, success, permanent, error, `duration_ms`) |
| `device_tokens` | Push tokens per tenant user |
| `inbox_messages` | In-app inbox per user (one per notification, read state, expiry) |

**Queries** live in repositories (`src/modules/*/*.repository.ts`), each extending
`BaseRepository<T>` (`src/database/postgres/base.repository.ts`): `create`, `insert`, `upsert`,
`save`, `findById`, `findOne`, `findMany`, `pluck`, `exists`, `count`, `updateWhere`
(conditional, returns rows changed), `updateById`, `deleteWhere`, `paginateByCursor` (keyset on
`created_at`, `id`; `created_at` is stored at millisecond precision to match the cursor),
`rawQuery`, `queryBuilder`, `transaction`. Services never call TypeORM directly.

To change the schema: edit a model in `src/models`, run
`npm run migration:generate -- src/database/postgres/migrations/<name>`, and add the class
to `src/database/postgres/migrations/index.ts`.

---

## 16. Scripts

| Script | Purpose |
| --- | --- |
| `npm run start:dev` | Watch mode (gRPC API + workers) |
| `npm run build` / `start:prod` | Compile and run (`APP_ROLE` decides the role) |
| `npm run start:api` / `start:worker` | Run a single role from `dist/` |
| `npm test` | Unit tests |
| `npm run test:e2e` | E2E tests over gRPC against real Postgres + Redis (`createdb communication_hub_test`) |
| `npm run migration:show` / `:run` / `:revert` / `:generate` | Migrations |
| `npm run lint` / `format` | oxlint / prettier |

### Project structure

```
proto/
  communication_hub/v1/   the API contract: notification, template, sender, provider, tenant, device
  grpc/health/v1/         standard gRPC health protocol
observability/            prometheus (scrape + alerts), loki, promtail, grafana (datasources, dashboard)
docs/ARCHITECTURE.md      design decisions
src/
  main.ts                 entry: gRPC server (api/all) or workers only (worker), by APP_ROLE
  app.module.ts           config, JSON logging with request context, i18n, infra, features, global guards/filter
  grpc/                   server options, proto codecs, validation, request context, error → status mapping
  gateway/                HTTP/JSON gateway + Swagger UI (OpenAPI generated from proto/)
  auth/                   AuthGuard (tenant / admin / public via metadata), per-tenant RateLimitGuard
  bootstrap/              startup tasks: sweeper schedule, bootstrap tenant
  config/                 typed config, env validation, environment.ts (.env + Secrets Manager)
  constant/               enums, provider kinds, queue names, limits, metadata keys, cache keys
  database/postgres/      connection, CLI data source, migrations, base.repository.ts
  decorator/              @CurrentTenant, @Public, @AdminOnly
  dto/                    validated RPC inputs
  models/                 TypeORM entities (encrypted columns via transformers)
  modules/
    notification/         gRPC controller, service, repositories, queue, dispatcher (failover), workers, sweeper
    template/             DB templates: versions, activation, preview, starter templates
    sender/               sender identities, rules, SenderResolver
    provider/             provider configs (admin), factory, registry (client pool), resolver (cache)
    tenant/               tenants, API keys (admin)
    device/               push token registry
    inbox/                in-app inbox: InboxService (gRPC), worker write, expiry purge
    health/               gRPC health, ops HTTP server (/health/*, /metrics)
  response/               error catalogue, translation
  utils/
    crypto/               FieldCipher (AES-256-GCM, blind index), column transformers, recipient masking
    metrics/              Prometheus registry and metrics
    channel/              provider contracts, PermanentDeliveryError, console provider
    email/ sms/ firebase/ vendor providers (smtp, ses, sendgrid, twilio, sns, fcm)
    queue/ redis/         BullMQ setup, Redis client + cache helper, rate limiter
    template/             Handlebars renderer (compiled-version LRU)
    request-context.ts    AsyncLocalStorage request context for logs
    secretManager.ts      fetchSecrets() from AWS Secrets Manager
  validator/              channel-aware validation rules (recipients, senders)
  views/                  starter template content
```

### Production checklist

- `APP_ENV` per environment, secret `communication-hub/<APP_ENV>-env` with its own
  `ENCRYPTION_KEYS` / `BLIND_INDEX_KEY` (back them up: losing them loses the data).
- A strong `ADMIN_API_KEY`; `GRPC_REFLECTION=false`; `SWAGGER_ENABLED=false` (or basic auth);
  TLS at the load balancer / mesh in front of `:50051` and `:3000` (the hub serves plaintext
  inside the cluster).
- `:9464` reachable from the cluster only (kubelet, Prometheus), never public.
- `APP_ROLE=api` and `APP_ROLE=worker` as separate deployments. Liveness `:9464/health/live`;
  readiness `:9464/health/ready` or a gRPC probe; HPA for workers on queue depth.
- Real platform default providers; tenant senders verified with their vendors;
  `<CHANNEL>_RATE_MAX` set to vendor limits.
- Redis with persistence (AOF) and `maxmemory-policy noeviction` (BullMQ requirement).
- Loki with object storage and Alertmanager routing for the alert rules.
