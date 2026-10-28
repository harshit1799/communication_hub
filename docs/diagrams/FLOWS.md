# Communication Hub: flow diagrams

The same diagrams as editable draw.io pages: [communication-hub-flows.drawio](communication-hub-flows.drawio).
Endpoints and request bodies for every step: [../http/](../http/) and [../API_GUIDE.md](../API_GUIDE.md).

1. [Setup and send, step by step](#1-setup-and-send-step-by-step)
2. [How one API call reaches the business logic](#2-how-one-api-call-reaches-the-business-logic)
3. [Delivery: queue, provider, failover, retry](#3-delivery-queue-provider-failover-retry)
4. [Notification status](#4-notification-status)
5. [In-app and push](#5-in-app-and-push)

## 1. Setup and send, step by step

Which API to call first, and what comes next.

```mermaid
flowchart TD
    A(["Start: service running<br/>GET :9464/health/ready"]) --> B["<b>1. Admin creates the tenant</b><br/>POST /v1/admin/tenants<br/>header x-admin-key"]
    B --> C{{"Response: apiKey.key<br/>shown once, save it"}}
    C --> D["<b>2. Tenant adds providers</b><br/>POST /v1/providers<br/>channel + vendor + credentials + from + fromAddresses + limits<br/>header x-api-key"]
    D --> E["Check From addresses<br/>GET /v1/from-addresses?channel=..."]
    E --> F["<b>3. Templates</b> (optional, starters otp / welcome exist)<br/>POST /v1/templates<br/>POST /v1/templates/{id}/preview"]
    F --> G{"Push or in-app?"}
    G -- yes --> H["<b>4. Register devices</b><br/>POST /v1/devices<br/>userId + FCM token"]
    G -- no --> I
    H --> I["<b>5. Send</b><br/>POST /v1/notifications<br/>channel + recipient/userId + template/body + from"]
    I --> J{{"202 Accepted<br/>notification.id + queue state"}}
    J --> K["<b>6. Track</b><br/>GET /v1/notifications/{id}<br/>status, providerName, sentFrom, attempts"]
    K --> L{"Status?"}
    L -- SENT --> M(["Done"])
    L -- FAILED --> N["POST /v1/notifications/{id}/retry"]
    N --> K
    L -- "QUEUED (scheduled)" --> O["POST /v1/notifications/{id}/cancel"]
    K -. in-app .-> P["<b>7. Inbox</b><br/>GET /v1/users/{user_id}/inbox<br/>POST .../inbox/read"]
```

## 2. How one API call reaches the business logic

There is no tenantId field in tenant APIs (for example `ListFromAddresses`): the tenant comes from the
`x-api-key` header. The guard resolves the key to its tenant, and the controller gets it as
`@CurrentTenant()`.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (Swagger / Postman / app)
    participant G as HTTP gateway :3000
    participant S as gRPC server :50051
    participant A as AuthGuard
    participant K as ApiKeyService
    participant R as Redis
    participant DB as Postgres
    participant Ctl as ProviderController
    participant Svc as ProviderConfigService

    C->>G: GET /api/v1/from-addresses?channel=CHANNEL_EMAIL<br/>x-api-key: chk_...
    Note over G: match path + verb from the proto's<br/>google.api.http, build the request message
    G->>S: ProviderService/ListFromAddresses<br/>metadata x-api-key
    S->>A: canActivate
    A->>K: resolve(key)
    K->>R: cached tenant for sha256(key)?
    alt cache miss
        K->>DB: api_keys + tenant by hash
        K->>R: cache it
    end
    K-->>A: TenantContext (tenantId, active)
    A-->>S: allowed, tenant attached
    S->>Ctl: @GrpcMethod ListFromAddresses(req, @CurrentTenant tenant)
    Ctl->>Svc: fromAddresses(tenant.tenantId, channel)
    Svc-->>Ctl: From list
    Ctl-->>S: ListFromAddressesResponse
    S-->>G: proto reply
    G-->>C: 200 JSON
```

A gRPC client skips the gateway and calls `:50051` directly with the same metadata.

## 3. Delivery: queue, provider, failover, retry

```mermaid
flowchart TD
    A["POST /v1/notifications"] --> B["Validate request<br/>tenant from x-api-key"]
    B --> C["Resolve template version<br/>and the From (name or address)"]
    C -->|unknown From name| X1(["404 FROM_NOT_FOUND"])
    C --> D["Save notification QUEUED<br/>recipient + data encrypted"]
    D --> E["Add BullMQ job on notifications-&lt;channel&gt;<br/>priority, delay, attempts/backoff from the provider limits"]
    E --> F(["202 + queue state"])
    E --> W["Worker picks the job<br/>env concurrency + platform rate limit"]
    W --> P["Load the tenant's providers for the channel<br/>Redis providers:&lt;tenant&gt;:&lt;channel&gt;<br/>→ Postgres → platform default (.env)"]
    P --> Q["Next provider in priority order<br/>that has the requested From"]
    Q --> T{"Provider at its rate /<br/>concurrency limit?<br/>(Redis)"}
    T -- yes, others left --> Q
    T -- "yes, all busy" --> DL["Job delayed until a slot frees<br/>no attempt used"]
    DL --> W
    T -- no --> V["Render template<br/>send via vendor: SMTP / SES / SendGrid / Twilio / SNS / FCM"]
    V --> R{"Result"}
    R -- success --> S1(["SENT<br/>provider, providerName, sentFrom, providerMessageId"])
    R -- temporary error --> Q2{"Another provider?"}
    Q2 -- yes --> Q
    Q2 -- no --> AT{"Attempts left?"}
    AT -- yes --> RT["RETRYING<br/>wait backoff × 2^n"]
    RT --> W
    AT -- no --> FL(["FAILED"])
    R -- permanent error --> FL
    V -.-> LOG[("Each provider call saved as an attempt:<br/>provider, providerName, sender, error, durationMs")]
```

## 4. Notification status

```mermaid
stateDiagram-v2
    [*] --> QUEUED: POST /v1/notifications (202)
    QUEUED --> PROCESSING: worker picks the job
    PROCESSING --> SENT: provider accepted it
    PROCESSING --> RETRYING: temporary error, attempts left
    RETRYING --> PROCESSING: after backoff
    PROCESSING --> FAILED: permanent error or attempts used up
    QUEUED --> CANCELLED: POST /{id}/cancel
    RETRYING --> CANCELLED: POST /{id}/cancel
    FAILED --> QUEUED: POST /{id}/retry
    SENT --> [*]
    CANCELLED --> [*]
```

## 5. In-app and push

```mermaid
sequenceDiagram
    autonumber
    participant B as Your backend
    participant H as Hub API
    participant Q as Queue + worker
    participant DB as Postgres
    participant F as Firebase (FCM)
    participant App as User's app

    B->>H: POST /v1/devices {userId, token, platform}
    H->>DB: save device token
    B->>H: POST /v1/notifications {channel: CHANNEL_IN_APP, userId, subject, body, alsoPush}
    H->>DB: notification QUEUED
    H-->>B: 202
    H->>Q: job on notifications-in-app
    Q->>DB: insert inbox message
    Q->>DB: user's active device tokens
    alt alsoPush = true
        Q->>F: visible push (title + body + metadata)
    else
        Q->>F: silent data message {type: inbox, unreadCount}
    end
    F->>App: notification / refresh signal
    App->>B: user opens the inbox
    B->>H: GET /v1/users/{user_id}/inbox
    B->>H: POST /v1/users/{user_id}/inbox/read {ids}
    Note over Q,F: CHANNEL_PUSH skips the inbox:<br/>worker → FCM to every device of userId (or one token)
```
