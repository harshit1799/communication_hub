# Architecture and design decisions

How the Communication Hub is built and why. Usage is in the [README](../README.md).

## System overview

```
                  gRPC :50051 (TLS terminated at LB / mesh)
 tenant services ─────────────────────────────► api pods (APP_ROLE=api, stateless)
 platform admins ─── x-admin-key ─────────────►   │  validate, pin template version,
                                                  │  encrypt, INSERT, enqueue job(id)
                                                  ▼
                        PostgreSQL ◄──── source of truth ────► Redis
                        (rows, configs,                       (BullMQ queues, config cache,
                         encrypted PII)                        rate limits, API keys)
                                                  ▲
                                                  │  claim row, render, resolve providers
                                                  │  providers (cache), send with failover
                                       worker pods (APP_ROLE=worker, scale on queue depth)
                                                  │
                         tenant's vendors: SES · SendGrid · SMTP · Twilio · SNS · FCM

 every pod :9464 ── /metrics ──► Prometheus ──► Grafana ◄── Loki ◄── Promtail ◄── stdout JSON
```

## Decisions

### 1. gRPC as the only business API

- **Contract first.** `proto/communication_hub/v1` is the API; clients generate typed stubs in
  any language. Breaking changes require a new package (`v2`), additive ones are safe
  (proto3 field rules).
- **Transport separated from logic.** Controllers only decode proto (enums, `Timestamp`,
  `Struct`, see `src/grpc/codecs.ts`), validate into DTOs and map results back. Services know
  nothing about gRPC, so a second transport would be a thin layer.
- **Errors** are standard status codes plus `error-type` / `error-data` trailers: generic gRPC
  tooling (retries on `UNAVAILABLE`, dashboards by code) works, and clients can still branch on
  a precise type.
- **Ops on plain HTTP (`:9464`)**, in every role: kubelet probes, Prometheus scrapes and workers
  (no gRPC server) all need it. Kept off the public port. `grpc.health.v1` is also implemented
  for gRPC-native probes and load balancers.
- **One application instance per process**: `createMicroservice` with async options reads the
  port from `ConfigService` after Secrets Manager, rather than a second bootstrap context.

### 1b. HTTP/JSON gateway + Swagger, generated from the protos

- REST routes are declared per RPC with the standard `google.api.http` annotation
  (`get: "/v1/notifications/{id}"`, `body: "*"`, ...): GET for reads, POST for creates and
  actions, PATCH for updates, DELETE for deletes. `src/gateway` binds path, query and body to
  the request message (proto3 JSON) and calls the **local gRPC server** as a client. One implementation, one pipeline: auth, rate limits,
  validation, errors, logs and metrics are identical for HTTP and gRPC clients (cost: a
  loopback hop).
- The OpenAPI 3 document is built at startup from the same `.proto` files (protobufjs
  reflection, comments as descriptions), so Swagger can't drift from the contract.
- Swagger UI assets are served from `swagger-ui-dist` under a strict CSP (no CDN, no inline
  scripts). Off by default outside local; optional basic auth.
- Alternative considered: Envoy / grpc-gateway transcoding. Better for very high HTTP volume
  (no extra hop in Node), but another component to deploy; the in-process gateway can be
  replaced without touching clients since the paths follow the gRPC method names.

### 2. Templates in the database, immutable versions

- `templates` (name, channel, `active_version`) + `template_versions` (never updated). Publishing
  = insert v N+1 (+ move the pointer); rollback = move the pointer. No deployments.
- **Pin at accept time.** The notification stores `template_id` + `template_version`. Retries,
  sweeper re-enqueues and delayed sends render exactly what the client was told was accepted.
- **Validate before publish:** channel rules + full Handlebars compile, so a broken template
  can't reach the worker. Runtime render failures are permanent errors (no pointless retries).
- **Caching follows mutability:** the name → active-version pointer is cached with a TTL and
  deleted on change; version content is immutable (long TTL, no invalidation); compiled
  templates sit in an in-process LRU keyed by version id.

### 3. The "From" is a provider setting

- No separate sender entities: each provider config carries its `settings.from` (email
  address or SMS sender id), and a send may override it with `from`. One concept for the
  tenant to manage instead of three (providers, senders, sender rules).
- Resolved per provider call in the worker (request `from` → `settings.from` → `MAIL_FROM`),
  so in a failover chain each vendor sends as an identity verified with *that* vendor.
- The format is validated (email / `Name <address>`; E.164, short code, alphanumeric id);
  ownership is the vendor's job (SES identity, Twilio number, DLT registration).
- Earlier versions had sender identities and sender rules (prefix / domain / template);
  migration `1764` moved default senders into `settings.from` and dropped them.

### 4. Providers per tenant from DB, read through Redis (tenant-managed)

- `provider_configs` per tenant and channel: kind, non-secret `settings` (incl. `from`),
  encrypted `credentials`, `priority`, active flag. Validated per kind on write
  (`provider.factory.ts`). Managed by the **tenant** with its own key (`ProviderService`):
  the admin only creates tenants and keys. Trade-off: a leaked tenant key can change the
  tenant's providers; credentials are still never readable.
- **Send path never hits Postgres in the steady state:** `providers:<tenant>:<channel>` in Redis
  (TTL `PROVIDER_CACHE_TTL_SECONDS`), DB on miss or Redis outage, platform default (env) when a
  tenant has none. Admin writes delete the key: changes apply to the next message on every
  worker. The TTL bounds staleness if a delete is lost.
- **Credentials stay ciphertext in Redis** and are decrypted only in-process when a client is
  built: a Redis dump leaks nothing.
- **Client pool** (`ProviderRegistry`): one client per `(config id, updated_at)`. SMTP pools and
  Firebase apps are reused; a new version replaces and closes the old client; idle ones close
  after 15 minutes.
- **Failover inside one attempt**, in priority order, on transient errors only. Every provider
  call is an attempt row, so the audit shows the whole chain. Permanent errors don't fail over.
  Client creation is lazy per provider, so one malformed config can't block its backups.

### 5. Encryption of personal data

- AES-256-GCM via TypeORM column transformers (`notifications.recipient`, `notifications.data`,
  `provider_configs.credentials`): encryption can't be forgotten in a new query path.
- GCM additional data = column name: ciphertexts can't be moved between columns.
- Key ids in the ciphertext (`enc:v1:<kid>:`) allow rotation without downtime.
- Equality lookups via a **blind index** (`recipient_hash` = HMAC-SHA256 under a separate key,
  scoped by tenant, recipient normalised). Range/prefix search on recipients is deliberately
  impossible.
- Keys come from the environment (Secrets Manager in deployed environments). **Next step:**
  envelope encryption with AWS KMS (data keys per tenant), which also enables crypto-shredding
  on tenant deletion.
- Not encrypted (by design or for now): `device_tokens.token` (needed for FCM fan-out lookups
  and dead-token deactivation; can move to the same pattern), inline `subject`/`body`
  (tenant-supplied content: prefer templates + `data` for personal values).

### 5b. In-app notifications

- A channel like the others (`CHANNEL_IN_APP`, own queue, same retries / priorities /
  idempotency / sweeper), so in-app traffic can't delay email or push and vice versa.
- **The inbox row is the delivery**, written once per notification (unique
  `notification_id`, `INSERT … ON CONFLICT DO NOTHING`), so retries and re-enqueues are safe.
- **Devices are signalled after the write**, through the tenant's *push* providers (same
  failover, same dead-token cleanup): a silent data message by default, a visible push with
  `alsoPush` ("inbox + push" from one request, one notification, one audit trail). The
  signal is best effort by design: the source of truth is the inbox, and apps re-sync.
- The unread count is a partial-index count (`read_at IS NULL`), sent in the signal so apps
  update badges without an extra call.
- Retention: `expires_at` per row; reads hide expired rows immediately, an hourly
  maintenance job deletes them in 5,000-row batches (short locks, no table bloat spikes).
- Next steps: real-time delivery to web clients (server-streaming RPC / SSE), per-category
  preferences and quiet hours.

### 6. Observability

- **Logs:** pino JSON on stdout; `AsyncLocalStorage` carries `requestId` / `rpc` / `tenantId`
  into every line, and the request id travels in the job, so one id follows a message from
  the API call through every delivery attempt. Delivery outcomes are typed events
  (`delivery_sent|retry|failed`, `provider_failover`). Redaction and recipient masking keep PII
  and secrets out.
- **Metrics:** prom-client, low-cardinality labels only (channel, provider kind, outcome,
  method, code). Tenant-level analysis belongs in logs (Loki) or the database, not in metric
  labels. Queue depth is read from BullMQ at scrape time.
- **Stack:** Promtail → Loki, Prometheus (+ alert rules) → Grafana with provisioned
  datasources and dashboard. Loki labels: `compose_service`, `level`, `event`, `channel`.

### 7. Reliability properties (unchanged and extended)

Postgres is the source of truth; jobs carry only ids. Commit-then-enqueue with a sweeper for
orphans; idempotency by unique index; conditional status transitions; priority queues per
channel; graceful shutdown that finishes and records in-flight sends. Delivery is
at-least-once.

## Migration notes (`1762000000000-templates-senders-providers`)

- Creates the new tables, encrypts existing `recipient` / `data` in batches and fills
  `recipient_hash`, moves `settings.emailFrom` / `smsFrom` to default senders (since `1764`: to the providers'
  `settings.from`), seeds the
  starter templates per tenant and links existing notifications to them.
- `created_at` of `tenants`, `notifications` and `templates` becomes `timestamptz(3)`: the old
  microsecond values made cursor pagination skip rows created in the same millisecond (the
  cursor is a JS `Date`).
- Runs in the migration transaction. For very large `notifications` tables, split it: schema
  first, backfill as a background job, then switch reads.
- `down()` decrypts and restores the previous schema.

## Known limits / next steps

- KMS envelope encryption and a re-encryption job for key rotation.
- Per-provider circuit breaker (currently every message tries a failing primary first;
  failover makes this correct but adds its latency until the config is deactivated).
- Provider delivery receipts (SES/SNS events, Twilio status callbacks) to move from
  "accepted by vendor" to "delivered".
- Per-key scopes (e.g. a send-only key that can't change providers or templates).
- Server-streaming `WatchNotification` for clients that want push instead of polling.
