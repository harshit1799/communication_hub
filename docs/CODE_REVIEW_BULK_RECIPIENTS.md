# Code review: multi-recipient bulk send

| | |
| --- | --- |
| Code reviewed | Commit `2622d77` "change in send bulk notification" plus the current working-tree changes |
| Feature | `POST /v1/notifications/bulk` accepts several targets per item (`recipients`, `userIds`, or a comma-separated `recipient`); each target becomes its own notification |
| Review date | 2026-10-28 |
| Verdict | **PASS WITH COMMENTS** |

**Scope**

- [notification.proto](../proto/communication_hub/v1/notification.proto): `recipients` / `user_ids` fields on `NotificationInput`
- [bulk-targets.ts](../src/modules/notification/bulk-targets.ts): `countTargets` (size check) and `expandBulkItem` (the split)
- [notification.controller.ts](../src/modules/notification/notification.controller.ts): `sendBulk` runs the size check, the split and validation
- [notification.service.ts](../src/modules/notification/notification.service.ts): `sendMany` / `validate`, which the split feeds into
- Repository insert, queue inspection, and the tests ([bulk-targets.spec.ts](../src/modules/notification/bulk-targets.spec.ts), [app.e2e-spec.ts](../test/app.e2e-spec.ts))

Generated docs (xlsx, csv, `.http`) were not reviewed as code.

**Stack:** TypeScript, NestJS 12, gRPC with an in-process HTTP gateway, Postgres / TypeORM, Redis, BullMQ, Docker; a modular monolith with API and worker roles.

**How it was checked:**
- Read every changed file line by line.
- Timed the size check on the compiled code.
- Ran the typecheck, the unit and end-to-end tests, oxlint, Prettier and `npm audit`.

| Check | Result |
| --- | --- |
| Typecheck (`tsc --noEmit`) | Clean |
| Unit tests | 130 passed (11 files) |
| End-to-end tests | 64 passed (6 files) |
| oxlint (`--type-aware`) | No warnings in the changed files |
| Prettier | Flags the changed files (L7) |

---

## 1. Executive summary

The feature is sound:
- The API change only adds fields, so existing clients are unaffected.
- Oversized requests are rejected before any per-target work.
- Idempotency keys are stable per recipient, whatever the length of the list.
- Each recipient gets its own notification, status and retry.

No Critical or High issues were found. The main open point is **M1**: the per-recipient key suffix is an unkeyed hash of the recipient, stored in plain text, which weakens the encryption of recipients at rest. It should be the first follow-up, together with M5 (moving the bulk logic into the service).

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 0 |
| Medium | 5 |
| Low | 7 |

---

## 2. Findings

### Critical

No issues found.

### High

No issues found.

### Medium

| # | Issue | Where | Impact | Fix |
| --- | --- | --- | --- | --- |
| M1 | **The key suffix is a plain (unkeyed) SHA-256 of the recipient**, stored in plain text in `idempotency_key` and returned in responses. Every list-form item with a key gets one. | [bulk-targets.ts:42-43](../src/modules/notification/bulk-targets.ts#L42-L43) | The phone-number space is about 10¹⁰, so a leaked DB dump recovers numbers by brute force. That undoes the encryption of recipients at rest, and the file's comment ("no recipient ends up in plain text") overstates the protection. | Use the service's keyed per-tenant hash (`cipher.blindIndex`, the one behind `recipientHash`). This requires moving the split into the service (M5). |
| M2 | **Validation errors use the expanded index**, not the client's item index. | controller → `validateInput` | With item 0 having 3 recipients, a bad item 1 is reported as `notifications.3.recipient …`. Clients can't map the error to their item. | Validate each original item and report `notifications.<i>.recipients[<j>]`, or map indexes back. |
| M3 | **Keys of 239–255 characters break on list-form items.** The `:` plus 16 hex characters pushes them past `IDEMPOTENCY_KEY_MAX` (255). | [bulk-targets.ts:42](../src/modules/notification/bulk-targets.ts#L42) | A key accepted on single send is rejected on bulk, with a length message that doesn't mention the suffix. | Limit the base key to `MAX - 17` for list-form items, with an explicit message. |
| M4 | **Repeated work per split item.** The split makes 500 identical items the normal case. | `validate()` and `sendMany` in [notification.service.ts](../src/modules/notification/notification.service.ts) | `validate()` compiles the inline `subject` / `body` with Handlebars for every item (`renderText` isn't cached): up to 500 compiles of the same 50 KB body. The response calls `queue.inspect` per notification: 500 × 2 Redis round trips. | Compile each distinct text once. Batch queue inspection (pipeline or `getJobs`), or return it only for single sends. |
| M5 | **Business logic in the transport layer.** The size check, the split and key derivation live in the controller, whose header says "transport layer only … the logic lives in NotificationService". | [notification.controller.ts:152-167](../src/modules/notification/notification.controller.ts#L152-L167) | Other entry points (a future queue consumer, admin tooling) would skip the size check and the split, and the keyed hash from M1 isn't available in the controller. | Move it into `NotificationService.sendBulk(tenantId, items)`. |

### Low

| # | Issue | Fix |
| --- | --- | --- |
| L1 | `expandBulkItem` returns `T[] \| string`: an error message mixed into the result type. | Return a discriminated result (`{ ok: true, items } \| { ok: false, error }`) or throw. |
| L2 | **Two forms for one concept** (`recipients[]` and a comma-separated `recipient`). The comma form also applies to push tokens. The forms also derive keys differently: a plain `recipient` keeps the key as sent, while the list form adds a per-target suffix. So switching one recipient between the forms under the same key sends it again. The behaviour is documented in the code comment. | Keep the array as the documented form; limit the comma form to email / SMS or deprecate it. Document the key rule in the API guide. |
| L3 | `recipients` / `user_ids` sit on the shared `NotificationInput`, so Swagger shows them on single send, where they're rejected. | A separate `BulkNotificationInput` message (still additive and backward compatible). |
| L4 | **Missing tests:** the both-lists error over gRPC, and a 239–255-character key on a list-form item. | Add them with M3. |
| L5 | No metric for split size. | A histogram of targets per bulk request. |
| L6 | A derived key could collide with a client's own key shaped like `x:<16 hex>`. | Negligible; use a separator clients can't send, or document it. |
| L7 | Prettier flags the changed files, but older, untouched code fails the same check: repo-wide config drift, not this change. | Run `prettier --write` repo-wide in a separate commit. |

---

## 3. Security

| Area | Result |
| --- | --- |
| SQL / NoSQL / command injection, path traversal, XXE, SSRF, open redirect, insecure deserialization, file upload | No issues found. TypeORM queries are parameterised; the change has no file, URL or shell handling. |
| XSS / output encoding | No issues found. The hub stores and forwards content; there's no HTML output path in this change. |
| Authentication, authorization, access control | No issues found. The tenant comes from `x-api-key` (`AuthGuard`, `@CurrentTenant()`), and every split notification stays inside that tenant. |
| JWT, sessions, cookies, CSRF, CORS, security headers | Not affected by this change. No issues found. |
| Secrets, hard-coded credentials | No issues found. |
| Sensitive data exposure | **M1.** No new log lines; existing logs mask recipients. |
| Input validation | **M3.** The total is capped at 500 targets before expanding; each split item then passes the full DTO rules. |
| Rate limiting | The per-tenant throttle counts requests, not targets, so one request can do up to 500× the work. Acceptable, because the size check runs before any per-target work. |
| Exception handling, information leakage | No issues found. Errors are `VALIDATION_ERROR` (gRPC `INVALID_ARGUMENT`, HTTP 400) and leak no internals. |
| Dependencies (outside this change) | `npm audit --omit=dev`: body-parser and multer (High, DoS); nodemailer ≤ 10.1.3 (Moderate: addressparser bugs that can turn display text into extra recipients, relevant because `from` accepts display names); deepmerge (prototype poisoning). `npm audit fix` covers most. |

## 4. Performance and complexity

**Size check.**
- `countTargets` reads array lengths and counts commas with `indexOf`, without splitting the string.
- On the compiled code, a request listing about 330k phone numbers is rejected in **0.03 ms** as a list, or **4.7 ms** as a 4.6 MB comma-separated string.
- The gateway still has to parse the body first, but that is bounded by `BODY_LIMIT_BYTES` (5 MB) and `GRPC_MAX_MESSAGE_BYTES` (8 MB).

**The split.** Objects are copied shallowly, so `body` and `data` are shared between items rather than duplicated, and `unique()` deduplicates with a `Set`.

**M4.** A Handlebars compile per item, and two Redis round trips per notification in the response.

T = total targets listed (at most 500 once past the size check); r, u = recipients and userIds in one item; |b| = body size; |s| = length of a comma-separated `recipient`.

| Function | Time (best / avg / worst) | Space | Suggested |
| --- | --- | --- | --- |
| `countTargets()` | O(1) without a comma string / O(\|s\|) with one | O(1) | Fine as is |
| `unique()` | O(n) / O(n) / O(n) | O(n) Set | Fine as is |
| `expandBulkItem()` | O(1) plain item / O(r+u) / O(r+u), plus a hash per target when a key is set | O(r+u) shallow copies | Fine as is |
| `sendBulk` (controller) | Size check O(items + Σ\|s\|); expansion O(min(T, 500)) | O(min(T, 500)) | Fine as is |
| `validate()` | O(T·\|b\|) Handlebars compiles | O(T) | Compile distinct texts: O(distinct·\|b\| + T) |
| `insertIdempotent()` | O(T): one INSERT plus lookups by id and key | O(T) | Fine (indexed, batched) |
| Queue state in the response | 2T Redis round trips | O(T) | Pipeline: one round trip |

Memory per request is bounded at O(500) beyond the parsed body, and per-item allocation is near the minimum.

## 5. Code smells and refactoring

- Business logic in a controller that says it holds none (M5).
- An error message mixed into the return type (L1).
- Two input forms for one concept (L2).
- A comment that claims more privacy than the code gives (M1).

Refactoring:

- Move the size check, the split and key derivation into `NotificationService.sendBulk` with the keyed hash. The service already builds the same `AppException(ERROR.VALIDATION_ERROR, …)` inline four times; one shared `invalid()` helper can serve both.
- Compile each distinct inline text once in `validate()`.

## 6. Category checklist

| # | Category | Result |
| --- | --- | --- |
| 1 | Security | M1, M3; dependency advisories outside this change |
| 2 | Architecture | M5, L1, L3. No circular dependencies, dead code or unused imports. |
| 3 | Performance | M4 |
| 4–5 | Time / space complexity | See [§4](#4-performance-and-complexity) |
| 6 | Database | No issues found. No schema change or migration; `INSERT … ON CONFLICT DO NOTHING` handles duplicate keys within one batch. |
| 7 | API | M2, M3, L2, L3. Additive and backward compatible; status 202; idempotent per recipient. |
| 8 | Naming | No issues found. `expandBulkItem`, `countTargets`, `BulkItem`, `keyFor`, `unique` follow the codebase's conventions (`uniqueTargets` would be more specific). |
| 9 | Code quality | No issues found beyond L1. Short functions, shallow nesting. |
| 10 | Error handling | M2. The global handler maps errors correctly. |
| 11 | Logging | L5. No sensitive data logged; request IDs still reach the jobs. |
| 12 | Validation | M2, M3 |
| 13 | Concurrency | No issues found. The split is a pure function; concurrent duplicate keys are handled by the database constraint. |
| 14 | Dependencies | No new dependencies. Advisories outside this change ([§3](#3-security)). |
| 15 | Testability | L4. The helpers are pure (8 unit tests); end-to-end tests cover the split, replay, list growth under one key, the 500 cap and the single-send rejection. |
| 16 | Observability | L5. Metrics, tracing and health checks unaffected. |
| 17 | Scalability | M4. Stateless design; the queue path is unchanged. |
| 18 | Production readiness | No issues found. Config, secrets, shutdown and deployment unaffected. |
| 19 | Linting / standards | oxlint: no warnings in the changed files (2 in `notification.service.ts` are outside this change). Prettier: L7. |

## 7. Suggested code

### M1, M3 and M5: bulk logic in the service, with the keyed hash

```ts
// notification.service.ts
/** Bulk send; items may list several targets (one notification each). */
async sendBulk(tenantId: string, items: BulkItem[], requestId?: string): Promise<SendResult[]> {
  let total = 0;
  for (const item of items) {
    total += countTargets(item);
    if (total > LIMITS.BULK_MAX) throw invalid(`a bulk request can list at most ${LIMITS.BULK_MAX} targets in total`);
  }
  // Keyed per-tenant hash instead of a plain SHA-256.
  const hashTarget = (channel: string, target: string) => this.recipientHash(tenantId, channel, target).slice(0, 16);
  const dtos = items.flatMap((item, index) => expandBulkItem(item, hashTarget, index));
  const { notifications } = validateInput(SendBulkNotificationDto, { notifications: dtos });
  return this.sendMany(tenantId, notifications, NotificationPriority.Low, requestId);
}
```

```ts
// Inside expandBulkItem(item, hashTarget, index):
if (listForm && base.idempotencyKey && base.idempotencyKey.length > LIMITS.IDEMPOTENCY_KEY_MAX - 17) {
  throw invalid(`notifications.${index}: idempotencyKey must be at most ${LIMITS.IDEMPOTENCY_KEY_MAX - 17} characters with a list of targets`);
}
```

Switching to the keyed hash changes the derived keys, so a request sent before the change and repeated after it would not replay. Deploy it at a quiet point, or accept that as a one-time window.

### M4: compile each distinct text once

```ts
// validate(): one compile per distinct subject / body across the request
const checked = new Set<string>();
for (const text of [dto.subject, dto.body]) {
  if (!text || checked.has(text)) continue;
  checked.add(text);
  this.templates.renderText(text, dto.data ?? {}); // keep the existing try/catch
}
```

This check catches template syntax errors (the compile uses `strict: false`), so running it once per distinct text is equivalent to running it per item.

## 8. Scorecard

| Area | Score |
| --- | --- |
| Security | ★★★★☆ |
| Performance | ★★★★☆ |
| Scalability | ★★★★☆ |
| Readability | ★★★★☆ |
| Maintainability | ★★★☆☆ |
| Architecture | ★★★☆☆ |
| Code quality | ★★★★☆ |
| Testing | ★★★★☆ |
| Documentation | ★★★★☆ |
| Production readiness | ★★★★☆ |

## 9. Recommendation

**Approve: YES, with comments.** There are no Critical or High issues. Requests are size-checked before any per-target work, idempotency holds per recipient, and the behaviour is covered by unit and end-to-end tests.

Recommended follow-ups, in order:

1. M1 together with M5 (one refactor).
2. M3, with the remaining tests from L4.
3. M2 and M4.
4. The Low items as convenient.
