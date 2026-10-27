# API guide: from zero to a delivered notification

The whole flow in four steps:

```
1. Admin    creates a tenant          → gets the tenant's API key
2. Tenant   adds its providers        → vendor + credentials + "From" + priority, per channel
3. Tenant   adds templates (optional) → versioned, dynamic content
4. Tenant   sends by channel          → POST /notifications, then track the result
```

Every request and response below comes from a real run (ids and keys replaced by
placeholders). The examples use the **REST API** (`curl`); every call has an identical **gRPC**
method ([§11](#11-the-same-calls-over-grpc)). Try everything in **Swagger UI** at
http://localhost:3000/docs.

**Contents**
1. [Roles and keys](#1-roles-and-keys)
2. [Start the service](#2-start-the-service)
3. [Create a tenant and get its API key (admin)](#3-create-a-tenant-and-get-its-api-key-admin)
4. [Add providers (tenant)](#4-add-providers-tenant)
5. [Templates (tenant)](#5-templates-tenant)
6. [Register devices for push and in-app (tenant)](#6-register-devices-for-push-and-in-app-tenant)
7. [Send notifications](#7-send-notifications)
8. [Track delivery, retry and cancel](#8-track-delivery-retry-and-cancel)
9. [In-app inbox](#9-in-app-inbox)
10. [Errors](#10-errors)
11. [The same calls over gRPC](#11-the-same-calls-over-grpc)
12. [Checklist](#12-checklist)

---

## 1. Roles and keys

| Role | Header | Does |
| --- | --- | --- |
| **Platform admin** | `x-admin-key: <ADMIN_API_KEY>` (from `.env` / Secrets Manager) | creates, updates and deactivates **tenants**; issues and revokes their **API keys**. Nothing else. |
| **Tenant** | `x-api-key: chk_...` (from step 3) | everything for itself: **providers** (with credentials), **templates**, **devices**, **sending** and reading its notifications and inbox |

- A tenant only ever sees its own data; another tenant's id answers `404`.
- Provider credentials are encrypted and **never returned**, not even to the tenant.
- Kill switches: revoke a key (immediate) · deactivate a tenant (every key gets `403`) ·
  deactivate a provider (the next message skips it).
- Keep the tenant key in the backend, **never in a mobile app or browser**: whoever has it can
  send messages and change the tenant's providers. All keys of a tenant have the same rights.

---

## 2. Start the service

```bash
npm run start:dev            # or: docker compose up --build
```

| What | Address |
| --- | --- |
| REST API | `http://localhost:3000/api/v1` |
| Swagger UI | http://localhost:3000/docs |
| gRPC | `localhost:50051` |
| Health | http://localhost:9464/health/ready |

```bash
export BASE=http://localhost:3000/api/v1
export ADMIN_KEY=<ADMIN_API_KEY from .env>
curl http://localhost:9464/health/ready      # {"ready":true,"database":"up","redis":"up",...}
```

| Header | Required | Purpose |
| --- | --- | --- |
| `Content-Type: application/json` | for bodies | |
| `x-admin-key` / `x-api-key` | yes | credentials (§1) |
| `x-request-id` | no | your trace id; echoed back and written to every log line of the request **and** of the worker that delivers it |
| `language` | no | language of error messages |

---

## 3. Create a tenant and get its API key (admin)

```bash
curl -X POST $BASE/admin/tenants \
  -H 'Content-Type: application/json' -H "x-admin-key: $ADMIN_KEY" \
  -d '{ "name": "Acme Inc.", "slug": "acme", "settings": { "appName": "Acme" } }'
```

`201 Created`:

```json
{
  "tenant": {
    "id": "<TENANT_ID>", "name": "Acme Inc.", "slug": "acme", "active": true,
    "settings": { "appName": "Acme" },
    "createdAt": "2026-10-27T06:37:33.601Z", "updatedAt": "2026-10-27T06:37:33.600Z"
  },
  "apiKey": {
    "apiKey": { "id": "<KEY_ID>", "name": "default", "prefix": "chk_1zzfMyTm", "createdAt": "2026-10-27T06:37:33.630Z" },
    "key": "chk_1zzfMyTm-EGz5S6_VEShKu_..."
  }
}
```

- **`apiKey.key` is shown only once** (only a hash is stored). Give it to the tenant securely:
  ```bash
  export API_KEY=chk_1zzfMyTm-EGz5S6_VEShKu_...
  ```
- `slug`: 3-100 lowercase letters, digits or dashes, unique. `appName` is `{{appName}}` in templates.
- The tenant starts with **starter templates** (`otp`, `welcome`) and sends through the
  **platform default providers** from `.env` until it adds its own (§4). So it can send right away.

> Locally you can skip this step: `BOOTSTRAP_TENANT_*` in `.env` creates a tenant at startup,
> and `BOOTSTRAP_TENANT_API_KEY` is its key.

| Admin action | Request |
| --- | --- |
| Another key (rotation: create new → deploy → revoke old) | `POST $BASE/admin/tenants/<TENANT_ID>/api-keys` `{ "name": "backend-prod", "expiresAt": "2027-12-31T00:00:00Z" }` → `201` with `key` |
| List keys (never the key itself) | `GET $BASE/admin/tenants/<TENANT_ID>/api-keys` |
| Revoke a key (immediate) | `DELETE $BASE/admin/tenants/<TENANT_ID>/api-keys/<KEY_ID>` → `204` |
| List / get tenants | `GET $BASE/admin/tenants`, `GET $BASE/admin/tenants/<TENANT_ID>` |
| Rename / rebrand | `PATCH $BASE/admin/tenants/<TENANT_ID>` `{ "name": "...", "settings": { "appName": "..." } }` |
| Deactivate (all keys → `403 TENANT_INACTIVE`) | `PATCH $BASE/admin/tenants/<TENANT_ID>` `{ "active": false }` |

---

## 4. Add providers (tenant)

From here on, everything uses the **tenant key**.

A **provider** is a vendor account that delivers the tenant's messages: SES or SMTP for email,
Twilio or SNS for SMS, Firebase for push. Each provider has:

| Part | What | Example |
| --- | --- | --- |
| `channel` | which messages it delivers | `CHANNEL_EMAIL` |
| `provider` | the vendor | `ses` |
| `credentials` | the vendor login (encrypted, never returned) | `{ "access_key_id": "...", "secret_access_key": "..." }` |
| `settings` | non-secret options, incl. **`from`**: the default address it sends from | `{ "region": "eu-west-1", "from": "Acme <no-reply@acme.com>" }` |
| `fromAddresses` | more addresses on the same account, each with a **name** you send with | `{ "billing": "Acme Billing <billing@acme.com>" }` |
| `priority` | failover order, lower first (default 100) | `1` |

A tenant can add **several providers per channel**: they are tried in priority order and a
temporary failure on one **fails over** to the next. At send time the hub reads them from Redis
(falling back to the database), so every change applies to the **next message**.

### Add an email provider with several From addresses

One SMTP account that sends as three addresses, plus a default:

```bash
curl -X POST $BASE/providers -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" \
  -d '{
    "channel": "CHANNEL_EMAIL",
    "provider": "smtp",
    "name": "smtp-main",
    "priority": 1,
    "settings": { "host": "smtp.acme.com", "port": "587", "secure": "false", "from": "Acme <no-reply@acme.com>" },
    "credentials": { "user": "mailer@acme.com", "pass": "<SMTP_PASSWORD>" },
    "fromAddresses": {
      "support": "Acme Support <support@acme.com>",
      "billing": "Acme Billing <billing@acme.com>",
      "alerts":  "Acme Alerts <alerts@acme.com>"
    }
  }'
```

`201 Created`. Credentials come back only as their names:

```json
{
  "id": "<SMTP_PROVIDER_ID>", "channel": "CHANNEL_EMAIL", "provider": "smtp", "name": "smtp-main",
  "priority": 1, "active": true,
  "settings": { "from": "Acme <no-reply@acme.com>", "host": "smtp.acme.com", "port": "587", "secure": "false" },
  "fromAddresses": {
    "alerts": "Acme Alerts <alerts@acme.com>",
    "billing": "Acme Billing <billing@acme.com>",
    "support": "Acme Support <support@acme.com>"
  },
  "credentialKeys": ["pass", "user"],
  "createdAt": "2026-10-27T06:47:37.723Z", "updatedAt": "2026-10-27T06:47:37.723Z"
}
```

Add a backup (priority 2). If it should also send billing mail, give it a `billing` name too,
with the address verified on *its* vendor:

```json
{ "channel": "CHANNEL_EMAIL", "provider": "ses", "name": "ses-backup", "priority": 2,
  "settings": { "region": "eu-west-1", "from": "Acme <no-reply@mail.acme.com>" },
  "fromAddresses": { "billing": "Acme Billing <billing@mail.acme.com>" } }
```

### Other providers (same endpoint)

```jsonc
// SMS: Twilio, a US number by default, the Indian sender id and a short code by name
{ "channel": "CHANNEL_SMS", "provider": "twilio", "name": "twilio-main", "priority": 1,
  "settings": { "from": "+14155550100" },
  "fromAddresses": { "india": "ACMEIN", "otp": "56789" },
  "credentials": { "account_sid": "ACxxxxxxxx", "auth_token": "<TOKEN>" } }

// SMS: Amazon SNS as backup
{ "channel": "CHANNEL_SMS", "provider": "sns", "name": "sns-backup", "priority": 2,
  "settings": { "region": "ap-south-1", "from": "ACMEIN" } }

// Email: SendGrid
{ "channel": "CHANNEL_EMAIL", "provider": "sendgrid", "name": "sendgrid", "priority": 1,
  "settings": { "from": "Acme <no-reply@acme.com>" }, "credentials": { "api_key": "SG.xxxxx" } }

// Push (and in-app signals): the tenant's Firebase project
{ "channel": "CHANNEL_PUSH", "provider": "fcm", "name": "firebase", "priority": 1,
  "credentials": { "service_account": "{\"type\":\"service_account\",\"project_id\":\"acme-app\",...}" } }
```

| Provider | `settings` | `credentials` |
| --- | --- | --- |
| `smtp` | `host`*, `port`, `secure`, `from` | `user`, `pass` |
| `ses` | `region`*, `from` | `access_key_id`, `secret_access_key` (omit both to use the server's IAM role) |
| `sendgrid` | `from` | `api_key`* |
| `twilio` | `from` and/or `messaging_service_sid` | `account_sid`*, `auth_token`* |
| `sns` | `region`*, `from` (sender id) | `access_key_id`, `secret_access_key` (optional) |
| `fcm` | | `service_account`* (service account JSON as a string) |
| `console` | `from` | (logs only, for development) |

\* required. In-app notifications use the tenant's **push** providers.

### From addresses: which email or number a message is sent from

Every email and SMS has a "From": the address (`Acme Billing <billing@acme.com>`) or SMS sender
(`+14155550100`, short code `56789`, sender id `ACMEIN`) the recipient sees. Each provider has:

- **`settings.from`**: its default From;
- **`fromAddresses`**: more Froms on the same account, each with a **name** (1-50 lowercase
  letters, digits, dashes; up to 20 per provider).

When sending, the tenant picks the From **by name** (`"from": "billing"`) and the hub works out
everything else:

| The send has | Providers used (in priority order) | Each one sends as |
| --- | --- | --- |
| no `from` | all active providers of the channel | its `settings.from` (email without one: `MAIL_FROM`; SMS: the vendor default) |
| `"from": "billing"` (a name) | **only** the providers that have a `billing` name | its own `billing` address |
| `"from": "Acme <x@acme.com>"` (an address) | the providers that list that address, or all if none does | that address, as given |
| an unknown name | rejected right away: `404 FROM_NOT_FOUND` | |

So the name decides both **which address** and **which provider**: with `smtp-main` and
`ses-backup` above, `billing` goes through SMTP as `billing@acme.com` and, if SMTP is down,
fails over to SES as `billing@mail.acme.com`; `support` only exists on SMTP, so it never goes
through SES. Results from a real local run (console providers named `mailer-main` /
`mailer-backup`, set up like the two above, since there is no SMTP server locally):

| Send | Delivered from | By provider |
| --- | --- | --- |
| no `from` | `Acme <no-reply@acme.com>` | `mailer-main` |
| `"from": "billing"` | `Acme Billing <billing@acme.com>` | `mailer-main` |
| `"from": "alerts"` | `Acme Alerts <alerts@acme.com>` | `mailer-main` |
| `"from": "billing"`, `mailer-main` disabled | `Acme Billing <billing@mail.acme.com>` | `mailer-backup` |
| `"from": "support"`, `mailer-main` disabled | rejected: `404 FROM_NOT_FOUND` (no active provider has `support`) | |
| SMS, `"from": "india"` | `ACMEIN` | `sms-main` |

**See every From you can use**, with its provider:

```bash
curl "$BASE/from-addresses?channel=CHANNEL_EMAIL" -H "x-api-key: $API_KEY"
```
```json
{
  "fromAddresses": [
    { "address": "Acme <no-reply@acme.com>", "isDefault": true, "channel": "CHANNEL_EMAIL",
      "providerId": "<SMTP_PROVIDER_ID>", "providerName": "smtp-main", "provider": "smtp", "active": true },
    { "name": "alerts", "address": "Acme Alerts <alerts@acme.com>", "isDefault": false, "channel": "CHANNEL_EMAIL",
      "providerId": "<SMTP_PROVIDER_ID>", "providerName": "smtp-main", "provider": "smtp", "active": true },
    { "name": "billing", "address": "Acme Billing <billing@acme.com>", "isDefault": false, "...": "..." },
    { "name": "support", "address": "Acme Support <support@acme.com>", "isDefault": false, "...": "..." },
    { "address": "Acme <no-reply@mail.acme.com>", "isDefault": true, "providerName": "ses-backup", "...": "..." },
    { "name": "billing", "address": "Acme Billing <billing@mail.acme.com>", "providerName": "ses-backup", "...": "..." }
  ]
}
```

In failover order; `active: false` marks addresses of disabled providers (not used).

**And for every message, which From and provider were actually used:** `sentFrom` and
`providerName` on the notification, and `sender` + `providerName` + `providerId` on each
attempt (§8).

Every address must be **verified with the vendor** (SES identity, SendGrid sender, Twilio
number, DLT registration); the vendor rejects unverified ones.

Invalid configs are rejected before anything is stored, with every problem listed:

```json
// 400
{ "code": "INVALID_ARGUMENT", "type": "PROVIDER_CONFIG_INVALID",
  "message": "Provider config is invalid: from_addresses name \"Billing\" must be 1-50 lowercase letters, digits or dashes",
  "data": { "errors": [
    "from_addresses name \"Billing\" must be 1-50 lowercase letters, digits or dashes",
    "from_addresses.Billing is not a valid email address" ] } }
```

### Manage providers

| Action | Request |
| --- | --- |
| List (failover order) | `GET $BASE/providers?channel=CHANNEL_EMAIL` (omit `channel` for all) |
| Get one | `GET $BASE/providers/<PROVIDER_ID>` |
| Change priority | `PATCH $BASE/providers/<PROVIDER_ID>` `{ "priority": 5 }` |
| Disable / enable | `PATCH $BASE/providers/<PROVIDER_ID>` `{ "active": false }` |
| Change the default From | `PATCH $BASE/providers/<PROVIDER_ID>` `{ "settings": { "from": "Acme <hello@acme.com>" } }` |
| Add or change named Froms (merged) | `PATCH $BASE/providers/<PROVIDER_ID>` `{ "fromAddresses": { "news": "Acme News <news@acme.com>" } }` |
| Remove a named From | `PATCH $BASE/providers/<PROVIDER_ID>` `{ "fromAddresses": { "alerts": "" } }` |
| List every From | `GET $BASE/from-addresses?channel=CHANNEL_EMAIL` |
| Change settings (merged; `""` removes a key) | `PATCH $BASE/providers/<PROVIDER_ID>` `{ "settings": { "host": "smtp2.acme.com" } }` |
| Rotate credentials (replaced) | `PATCH $BASE/providers/<PROVIDER_ID>` `{ "credentials": { "user": "...", "pass": "..." } }` |
| Delete | `DELETE $BASE/providers/<PROVIDER_ID>` → `204` |

A channel with no active providers falls back to the platform default from `.env`.

---

## 5. Templates (tenant)

Templates are stored in the hub and **versioned**: publish, preview and roll back without a
deployment. Content uses Handlebars (`{{name}}`, `{{#if x}}...{{/if}}`). Every template also
gets `{{appName}}` and `{{year}}`.

```bash
# See what exists (starter templates are there from day one)
curl "$BASE/templates?channel=CHANNEL_EMAIL" -H "x-api-key: $API_KEY"

# Create (becomes version 1, active)
curl -X POST $BASE/templates -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" \
  -d '{
    "channel": "CHANNEL_EMAIL",
    "name": "invoice-ready",
    "description": "Invoice notification",
    "content": {
      "subject": "Invoice {{invoiceNo}} from {{appName}}",
      "html": "<p>Hi {{name}}, your invoice <b>{{invoiceNo}}</b> of {{amount}} is ready.</p>",
      "body": "Hi {{name}}, your invoice {{invoiceNo}} of {{amount}} is ready."
    }
  }'
```
```json
// 201
{ "id": "<TEMPLATE_ID>", "channel": "CHANNEL_EMAIL", "name": "invoice-ready", "description": "Invoice notification",
  "activeVersion": 1, "latestVersion": 1, "archived": false, "createdAt": "...", "updatedAt": "..." }
```

```bash
# Publish a new version (use "activate": false to stage it)
curl -X POST $BASE/templates/<TEMPLATE_ID>/versions -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" \
  -d '{ "content": { "subject": "Your {{appName}} invoice {{invoiceNo}}",
                     "html": "<p>Hello {{name}}, invoice <b>{{invoiceNo}}</b> ({{amount}}) is ready.</p>" },
        "activate": true }'

# Preview with sample data (nothing is sent)
curl -X POST $BASE/templates/<TEMPLATE_ID>/preview -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" \
  -d '{ "data": { "name": "Jane", "invoiceNo": "INV-1042", "amount": "$120" } }'
```
```json
{ "subject": "Your Acme invoice INV-1042",
  "html": "<p>Hello Jane, invoice <b>INV-1042</b> ($120) is ready.</p>" }
```

| Action | Request |
| --- | --- |
| Versions (newest first, `active` flag) | `GET $BASE/templates/<TEMPLATE_ID>/versions` |
| Roll back / publish a staged version | `POST $BASE/templates/<TEMPLATE_ID>/versions/1/activate` |
| Archive (no new sends; queued ones still go out) | `POST $BASE/templates/<TEMPLATE_ID>/archive` |

Content rules: **email** needs `subject` + `html` and/or `body`; **SMS** needs `body`;
**push / in-app** need `body` (`subject` = title). Broken Handlebars is rejected with `400
TEMPLATE_INVALID`. Each notification remembers the version it was sent with, so a retry
renders exactly the same content even after a new version is published.

---

## 6. Register devices for push and in-app (tenant)

Your backend registers each user's FCM token, e.g. at login (from the token your app sends you):

```bash
curl -X POST $BASE/devices -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" \
  -d '{ "userId": "user-42", "token": "<FCM registration token>", "platform": "DEVICE_PLATFORM_ANDROID" }'
```

`platform`: `DEVICE_PLATFORM_ANDROID` · `DEVICE_PLATFORM_IOS` · `DEVICE_PLATFORM_WEB`.
Re-registering refreshes the token. `GET $BASE/devices?user_id=user-42` lists them;
`DELETE $BASE/devices/<token>` removes one (e.g. at logout). Tokens FCM reports as dead are
deactivated automatically.

---

## 7. Send notifications

One endpoint for every channel: **`POST $BASE/notifications`** → `202 Accepted`. The message is
stored and queued; delivery happens in the background (normally within a second). Track the
outcome with §8.

### Email with a template

```bash
curl -X POST $BASE/notifications \
  -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" -H 'x-request-id: checkout-7781' \
  -d '{
    "channel": "CHANNEL_EMAIL",
    "recipient": "jane@example.com",
    "template": "invoice-ready",
    "data": { "name": "Jane", "invoiceNo": "INV-1042", "amount": "$120" },
    "idempotencyKey": "invoice-INV-1042"
  }'
```
```json
// 202
{
  "notification": {
    "id": "<NOTIFICATION_ID>", "channel": "CHANNEL_EMAIL", "recipient": "jane@example.com",
    "template": "invoice-ready", "templateVersion": 2,
    "data": { "name": "Jane", "invoiceNo": "INV-1042", "amount": "$120" },
    "status": "NOTIFICATION_STATUS_QUEUED", "priority": "PRIORITY_NORMAL",
    "idempotencyKey": "invoice-INV-1042", "attempts": 0, "metadata": {}, "alsoPush": false,
    "createdAt": "2026-10-26T08:29:22.184Z", "updatedAt": "2026-10-26T08:29:22.184Z"
  },
  "replayed": false,
  "attempts": [],
  "queue": {
    "queue": "notifications-email",
    "jobId": "<NOTIFICATION_ID>",
    "state": "active",
    "priority": 5,
    "attemptsMade": 0,
    "maxAttempts": 5
  }
}
```

The response tells you where the message is **right now**:

| Field | Meaning |
| --- | --- |
| `notification.status` | the stored status (`QUEUED` at accept time; the source of truth, read it later with `GET /notifications/{id}`) |
| `attempts` | delivery attempts so far: always `[]` for a new send (delivery happens in the background); the real history on a replay |
| `queue.queue` / `queue.jobId` | the delivery queue (one per channel) and the job id (= the notification id) |
| `queue.state` | `waiting` · `prioritized` (waiting, ordered by priority) · `delayed` (scheduled, or waiting for a retry) · `active` (being delivered now) · `completed` · `failed` · `not_enqueued` (the push to the queue failed; the sweeper enqueues it within ~3 minutes) · `removed` (finished jobs are pruned after an hour) |
| `queue.priority` | `1` high · `5` normal · `10` low (lower goes first) |
| `queue.attemptsMade` / `queue.maxAttempts` | attempts made / allowed before the message fails (`QUEUE_ATTEMPTS`) |
| `queue.runAt` | when a `delayed` job runs: exact for scheduled sends, approximate during retry backoff |

A fast worker can already show `active` or `completed` in the send response. `queue` is left
out if Redis can't be read at that moment; the send itself still succeeds.

A scheduled send (`"scheduledAt": "2026-10-28T09:00:00Z"`) answers with:

```json
"queue": { "queue": "notifications-sms", "jobId": "<NOTIFICATION_ID>", "state": "delayed",
           "priority": 5, "attemptsMade": 0, "maxAttempts": 5, "runAt": "2026-10-28T09:00:00.000Z" }
```

**Idempotency:** sending the same `idempotencyKey` again (e.g. your request timed out and you
retry) returns the **original** notification with `"replayed": true`, its `attempts` so far
and its current `queue` state, and nothing is sent twice. Use one key per logical message.

### Choose the From address

```json
{ "channel": "CHANNEL_EMAIL", "recipient": "jane@example.com",
  "subject": "Your receipt", "body": "Thanks for your payment.",
  "from": "billing" }
```

`from` is a **From name** from §4 (`billing`, `support`, `alerts`, ...) and decides which
address *and* which providers are used. It also accepts a full address
(`"Acme Billing <billing@acme.com>"`). Without `from`, each provider uses its default. An
unknown name is rejected immediately (`404 FROM_NOT_FOUND`).

### SMS (OTP, high priority)

```json
{ "channel": "CHANNEL_SMS", "recipient": "+919876543210", "template": "otp",
  "data": { "code": "482913", "expiresInMinutes": 5 }, "priority": "PRIORITY_HIGH" }
```

→ *"Acme: your verification code is 482913. It expires in 5 minutes. Never share this code."*,
sent from the provider's default number; add `"from": "india"` to send as `ACMEIN` (§4). Phone numbers must be **E.164** (`+` and country code).

### Push to all of a user's devices

```json
{ "channel": "CHANNEL_PUSH", "userId": "user-42",
  "subject": "Order shipped", "body": "Order {{orderId}} is on its way",
  "data": { "orderId": "ORD-77" }, "metadata": { "deeplink": "app://orders/77" } }
```

`subject` is the title; `metadata` arrives in the app as the FCM data payload (plus
`notificationId`). Use `"recipient": "<token>"` instead of `userId` for one device.

### In-app (inbox) + push

```json
{ "channel": "CHANNEL_IN_APP", "userId": "user-42",
  "subject": "Invoice ready", "body": "Invoice {{invoiceNo}} is ready",
  "data": { "invoiceNo": "INV-1042" }, "metadata": { "deeplink": "app://invoices/1042" },
  "alsoPush": true }
```

Stored in the user's inbox (§9). Without `alsoPush` the devices get a silent data message so
an open app refreshes its inbox and badge; with `alsoPush: true` they also show a regular push.

### Bulk (campaigns, up to 500)

```bash
curl -X POST $BASE/notifications/bulk -H 'Content-Type: application/json' -H "x-api-key: $API_KEY" \
  -d '{ "notifications": [
        { "channel": "CHANNEL_SMS", "recipient": "+14155550101", "body": "Sale starts now!" },
        { "channel": "CHANNEL_EMAIL", "recipient": "bob@example.com", "subject": "Sale", "body": "Sale starts now!" } ] }'
```

`202` with `accepted`, `replayed`, the notifications in request order and `queues` (the queue
state of each, same order). Bulk defaults to
`PRIORITY_LOW`, so single sends (OTPs) are never delayed by a campaign.

### Request fields

| Field | Channels | Notes |
| --- | --- | --- |
| `channel` | all | `CHANNEL_EMAIL` · `CHANNEL_SMS` · `CHANNEL_PUSH` · `CHANNEL_IN_APP` |
| `recipient` | email, SMS, push | email address · E.164 number · device token |
| `userId` | push, in-app | your user id: all devices (push) / the user's inbox (in-app, required) |
| `template` | all | template name; its active version is pinned on the notification |
| `templateVersion` | all | send a specific version instead of the active one |
| `subject` | email, push, in-app | required for email without a template; overrides the template subject |
| `body` | all | required without a template |
| `data` | all | values for `{{placeholders}}` (stored encrypted) |
| `metadata` | all | your references (string values); push/in-app: delivered to the app |
| `priority` | all | `PRIORITY_HIGH` (OTPs) · `PRIORITY_NORMAL` (single default) · `PRIORITY_LOW` (bulk default) |
| `scheduledAt` | all | e.g. `"2026-12-01T09:00:00Z"`, up to 30 days ahead |
| `idempotencyKey` | all | makes retries safe (max 255 characters) |
| `from` | email, SMS | a From name (`"billing"`, see §4) or an address; unset = each provider's default From |
| `alsoPush` | in-app | also show a visible push |

---

## 8. Track delivery, retry and cancel

```bash
curl $BASE/notifications/<NOTIFICATION_ID> -H "x-api-key: $API_KEY"
```

A delivered email sent with `"from": "billing"`, whose first provider (SMTP) was down, so it
**failed over** to the backup, which sent as its own billing address (illustration with the
§4 providers; the same flow is covered by the e2e tests with local providers):

```json
{
  "notification": {
    "id": "<NOTIFICATION_ID>", "channel": "CHANNEL_EMAIL", "recipient": "jane@example.com",
    "subject": "Your receipt", "body": "Thanks for your payment.",
    "from": "billing",
    "sentFrom": "Acme Billing <billing@mail.acme.com>",
    "providerName": "ses-backup",
    "status": "NOTIFICATION_STATUS_SENT", "attempts": 1,
    "provider": "ses", "providerMessageId": "0100018f...", "sentAt": "2026-10-27T06:47:40.236Z", "...": "..."
  },
  "attempts": [
    { "attempt": 1, "provider": "smtp", "providerName": "smtp-main", "providerId": "<SMTP_PROVIDER_ID>",
      "sender": "Acme Billing <billing@acme.com>", "success": false,
      "error": "connect ECONNREFUSED", "permanent": false, "durationMs": 3 },
    { "attempt": 1, "provider": "ses", "providerName": "ses-backup", "providerId": "<SES_PROVIDER_ID>",
      "sender": "Acme Billing <billing@mail.acme.com>", "success": true,
      "providerMessageId": "0100018f...", "permanent": false, "durationMs": 140 }
  ]
}
```

- `queue`: the job's live state (same fields as in the send response, §7), e.g.
  `{ "state": "completed", "attemptsMade": 1, "maxAttempts": 5, ... }`.
- `from`: what the send asked for (a name or an address); `sentFrom`: the address it was
  actually delivered from; `providerName`: the provider config that delivered it.
- Each entry of `attempts` is one provider call, with that provider's name, id and the From it
  used. Several entries with the same `attempt` number are a failover chain.


**Statuses:**

```
QUEUED ──► PROCESSING ──► SENT
              ├─► RETRYING ──► PROCESSING ──► …   (temporary errors, attempts left; backoff 5s, 10s, 20s, 40s)
              └─► FAILED                          (permanent error, or attempts used up)
QUEUED / RETRYING ──► CANCELLED                   (cancel)
FAILED ──► QUEUED                                 (retry)
```

| Action | Request |
| --- | --- |
| List (newest first) | `GET $BASE/notifications?status=NOTIFICATION_STATUS_FAILED&channel=CHANNEL_EMAIL&page.limit=20` |
| Next page | add `&page.cursor=<page.nextCursor from the previous response>` |
| Filter by recipient / user | `?recipient=jane@example.com` (exact match) · `?user_id=user-42` |
| Retry a failed one | `POST $BASE/notifications/<ID>/retry` |
| Cancel a queued / scheduled one | `POST $BASE/notifications/<ID>/cancel` → `NOTIFICATION_STATUS_CANCELLED` |

---

## 9. In-app inbox

Call these from your backend for the signed-in user:

```bash
curl "$BASE/users/user-42/inbox?unread_only=true&page.limit=20" -H "x-api-key: $API_KEY"
```
```json
{
  "messages": [
    { "id": "<INBOX_MESSAGE_ID>", "userId": "user-42", "notificationId": "<NOTIFICATION_ID>",
      "title": "Invoice ready", "body": "Invoice INV-1042 is ready",
      "metadata": { "deeplink": "app://invoices/1042" }, "read": false,
      "createdAt": "2026-10-26T08:29:22.274Z", "expiresAt": "2027-01-24T08:29:22.273Z" }
  ],
  "page": {},
  "unreadCount": 1
}
```

| Action | Request | Returns |
| --- | --- | --- |
| Unread badge | `GET $BASE/users/user-42/inbox/unread-count` | `{ "unreadCount": 1 }` |
| Mark read | `POST $BASE/users/user-42/inbox/read` `{ "ids": ["<INBOX_MESSAGE_ID>"] }` | new `unreadCount` |
| Mark all read | `POST $BASE/users/user-42/inbox/read-all` | `{ "unreadCount": 0 }` |
| Delete | `DELETE $BASE/users/user-42/inbox/<INBOX_MESSAGE_ID>` | new `unreadCount` |

Messages expire after `INBOX_RETENTION_DAYS` (default 90). In the app, an FCM message with
`data.type == "inbox"` means "refresh the inbox" (`unreadCount` is included).

---

## 10. Errors

Every error has the same body and a matching HTTP status:

```json
// 400
{ "code": "INVALID_ARGUMENT", "type": "VALIDATION_ERROR",
  "message": "Request validation failed: recipient must be an E.164 phone number, e.g. +14155550123",
  "data": { "errors": ["recipient must be an E.164 phone number, e.g. +14155550123"] } }
```

| HTTP | `type` | Typical cause |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | wrong field value; `data.errors` lists every problem |
| 400 | `TEMPLATE_INVALID`, `TEMPLATE_RENDER_FAILED`, `PROVIDER_CONFIG_INVALID` | broken template / placeholder / provider config |
| 401 | `API_KEY_MISSING`, `API_KEY_INVALID`, `ADMIN_KEY_INVALID` | missing, wrong, revoked or expired key |
| 403 | `TENANT_INACTIVE` | tenant deactivated by the admin |
| 404 | `NOTIFICATION_NOT_FOUND`, `TEMPLATE_NOT_FOUND`, `PROVIDER_CONFIG_NOT_FOUND`, ... | unknown id (or another tenant's) |
| 404 | `FROM_NOT_FOUND` | `from` is not a From name of an active provider and not a valid address |
| 405 | `METHOD_NOT_ALLOWED` | wrong HTTP verb (see the `Allow` header) |
| 409 | `TENANT_SLUG_TAKEN`, `TEMPLATE_NAME_TAKEN`, `PROVIDER_NAME_TAKEN` | already exists |
| 409 | `NOTIFICATION_NOT_RETRYABLE`, `NOTIFICATION_NOT_CANCELLABLE`, `TEMPLATE_ARCHIVED` | wrong state for the action |
| 429 | `TOO_MANY_REQUESTS` | tenant rate limit; wait `Retry-After` seconds |
| 503 | `SERVICE_UNAVAILABLE` | dependency down; retry with backoff |

A rejected request stores nothing. Delivery problems are **not** request errors: the send
returns `202`, and the notification later shows `NOTIFICATION_STATUS_FAILED` with `error` and
its `attempts`.

---

## 11. The same calls over gRPC

Every REST endpoint is a gRPC method (contract in `proto/communication_hub/v1`); the REST
route is declared next to it with `google.api.http`. Credentials go in metadata.

```bash
grpcurl -plaintext -H "x-api-key: $API_KEY" -d '{
  "notification": { "channel": "CHANNEL_SMS", "recipient": "+919876543210", "template": "otp", "data": { "code": "482913" } }
}' localhost:50051 communication_hub.v1.NotificationService/SendNotification
```

| REST | gRPC |
| --- | --- |
| `POST /admin/tenants` | `TenantAdminService/CreateTenant` |
| `POST /providers`, `PATCH /providers/{id}` | `ProviderService/CreateProvider`, `ProviderService/UpdateProvider` |
| `GET /from-addresses` | `ProviderService/ListFromAddresses` |
| `POST /templates`, `POST /templates/{id}/versions` | `TemplateService/CreateTemplate`, `TemplateService/CreateTemplateVersion` |
| `POST /devices` | `DeviceService/RegisterDevice` |
| `POST /notifications`, `GET /notifications/{id}` | `NotificationService/SendNotification`, `NotificationService/GetNotification` |
| `GET /users/{user_id}/inbox` | `InboxService/ListInboxMessages` |

gRPC errors use standard status codes, with the same `type` in the `error-type` trailer.

---

## 12. Checklist

1. **Admin:** `POST /admin/tenants` → give `apiKey.key` to the tenant securely.
2. **Tenant:** `POST /providers` per channel: vendor, credentials, `settings.from` and named
   `fromAddresses` (all verified with the vendor), and a second provider with a higher
   `priority` for failover. Check with `GET /from-addresses`. Skip it to use the platform defaults.
3. **Tenant:** `POST /templates` (or use the starters), check with `/preview`.
4. **Tenant:** `POST /devices` for push / in-app users.
5. **Tenant:** `POST /notifications` with an `idempotencyKey` (and `"from": "<name>"` to pick the
   From); read the result, incl. `sentFrom` and `providerName`, with `GET /notifications/{id}`.
6. **Ops:** watch Grafana (*Communication Hub* dashboard) and the alerts.
