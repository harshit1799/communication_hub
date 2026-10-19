# Communication Hub

White-label, multi-tenant notification service built on NestJS 12. Intended as a
boilerplate: channel delivery is pluggable and ships with console (log-only)
providers so the service runs out of the box.

## Requirements

- Node.js **22.12+** (`nvm use` picks it up from `.nvmrc`)
- PostgreSQL **13+**
- npm (use `npm ci` — the committed lockfile is required; a fresh resolve with
  npm 10 crashes on vite's optional peer deps, npm 11 is fine)

## Getting started

```bash
nvm use
npm ci
cp .env.example .env   # set DB_* to your Postgres
createdb communication_hub
npm run start:dev      # creates/updates tables automatically (migrations)
```

- API: http://localhost:3000/api
- Swagger UI: http://localhost:3000/docs (OpenAPI JSON at `/docs/json`)
- Health: http://localhost:3000/api/health

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run start:dev` | Watch mode |
| `npm run build` / `npm run start:prod` | Compile to `dist/` and run |
| `npm test` / `npm run test:e2e` | Unit / e2e tests (vitest); e2e needs a `communication_hub_test` database |
| `npm run migration:show` / `migration:run` / `migration:revert` | Inspect / apply / undo migrations |
| `npm run migration:generate -- src/database/migrations/<name>` | Generate a migration from entity changes |
| `npm run lint` / `npm run format` | oxlint / prettier |

## API

The send route is versioned and tenant-scoped via the `x-tenant-id` header
(use the **Authorize** button in Swagger).

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/v1/notifications` | Send via `email`, `sms`, `push` or `webhook` |
| GET | `/api/health` | Liveness check (503 if Postgres is unreachable) |

**Plain message**

```bash
curl -X POST localhost:3000/api/v1/notifications \
  -H 'content-type: application/json' -H 'x-tenant-id: acme' \
  -d '{"channel":"email","recipient":"jane@example.com","subject":"Hi","body":"Welcome!"}'
```

**Email from a template** (`template` = file name in `src/views` without `.html`, `data`
fills the `{{placeholders}}` in both the template and the subject)

```bash
curl -X POST localhost:3000/api/v1/notifications \
  -H 'content-type: application/json' -H 'x-tenant-id: acme' \
  -d '{"channel":"email","recipient":"jane@example.com",
       "subject":"Welcome to {{appName}}, {{name}}!","template":"welcome",
       "data":{"name":"Jane","actionUrl":"https://example.com/start"}}'
```

## Email templates

Each template is one complete HTML file (Handlebars syntax) directly in `src/views`:

```
src/views/
  welcome.html   data: name, actionUrl?
  otp.html       data: name, code, expiresInMinutes?
```

- To add an email, create `src/views/<name>.html`. You don't need to change
  any code.
- Every template gets `appName` (from `APP_NAME`) and `year`. Values in `data` override
  them, so a tenant can send its own `appName`.
- `{{value}}` is HTML-escaped. Only use `{{{value}}}` for trusted HTML.

## Configuration

Environment variables are validated at startup (`src/config/env.validation.ts`).
See `.env.example` for the full list: `PORT`, `API_PREFIX`, `CORS_ORIGINS`,
`SWAGGER_ENABLED`, `SWAGGER_PATH`, `APP_NAME`, `OBSERVE_APP_KEY`,
`OBSERVE_APP_SECRET`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
`SMTP_USER`, `SMTP_PASS`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`,
`DB_NAME`, `DB_SSL`, `DB_LOGGING`.

Email goes out over SMTP when `SMTP_HOST` is set. Otherwise it is logged to
the console.

## Database

PostgreSQL through TypeORM. Every send is saved in the `notifications` table:
first as `pending`, then updated to `sent` or `failed`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | `gen_random_uuid()` |
| `tenant_id` | varchar(100) | from the `x-tenant-id` header |
| `channel` | varchar(20) | email, sms, push, webhook |
| `recipient` | varchar(500) | |
| `subject` | varchar(255) null | final (rendered) subject |
| `body` | text null | plain-text content |
| `template` | varchar(100) null | template name from `src/views` |
| `data` | jsonb null | template values, so you can re-render the email later |
| `status` | varchar(20) | `pending` → `sent` / `failed` |
| `provider_message_id` | varchar(255) null | vendor id when sent |
| `error` | text null | reason when failed |
| `created_at` / `updated_at` | timestamptz | |

Index: `(tenant_id, created_at)`.

`channel` and `status` are stored as plain text instead of Postgres enums, so
adding a channel doesn't need a migration.

**Schema changes:** `synchronize` is off. Edit the entity, run
`npm run migration:generate -- src/database/migrations/<name>`, then add the new
class to `src/database/migrations/index.ts`. Pending migrations run
automatically when the app starts.

## Project structure

```
src/
  main.ts                    bootstrap + Swagger
  app.setup.ts               global pipes, prefix, versioning, helmet, CORS
  app.module.ts              config, observability, feature modules
  config/                    typed config + env validation
  database/                  connection, CLI data source, migrations
  common/                    tenant decorator, exception filter, swagger setup
  views/                     HTML email templates (copied to dist/views)
  modules/
    health/
    templates/               TemplatesService: renders views/ with Handlebars
    notifications/
      channels/              ChannelProvider contract, console + SMTP providers
      dto/ enums/
      entities/              notifications table mapping
      notifications.service.ts      renders template, saves, delivers, records result
      notifications.controller.ts   POST /api/v1/notifications
```

## Extending

- **Real delivery:** implement `ChannelProvider` (e.g. `TwilioSmsProvider`)
  and register it in the `CHANNEL_PROVIDERS` factory in
  `notifications.module.ts`.
- **Tenant auth:** `TenantId` (`common/decorators/tenant-id.decorator.ts`) trusts
  the header; swap it for API-key or JWT resolution before production.
- **Observability:** set `OBSERVE_APP_KEY`/`OBSERVE_APP_SECRET` to enable
  [NestJS Observe](https://observe.nestjs.com).
