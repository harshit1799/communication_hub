# Code review: multi-recipient bulk send

| | |
| --- | --- |
| Code reviewed | Commits `2622d77` and `7d5395c` ("change in send bulk notification") plus the current working-tree changes (the round 1 fixes) |
| Feature | `POST /v1/notifications/bulk` accepts several targets per item (`recipients`, `userIds`, or for email / SMS a comma-separated `recipient`); each target becomes its own notification |
| Review dates | Round 1: 2026-10-28. Round 2 (this document): 2026-10-30, against the fixed code |
| Verdict | Round 1: **PASS WITH COMMENTS**. Round 2: **PASS WITH COMMENTS** (one High issue that predates this change, see H1) |

**Scope (round 2)**

- [notification.proto](../proto/communication_hub/v1/notification.proto): new `BulkNotificationInput`; `NotificationInput` reserves 16 / 17
- [bulk-targets.ts](../src/modules/notification/bulk-targets.ts): `countTargets`, `expandBulkItem`, `LIST_KEY_MAX`, the comma rule per channel
- [notification.service.ts](../src/modules/notification/notification.service.ts): `sendBulk` (size check, fan-out, keyed hash, validation per item), `sendMany` (batched replay history), `validate` (one compile per distinct text)
- [notification.controller.ts](../src/modules/notification/notification.controller.ts): decode only
- [notification.queue.ts](../src/modules/notification/notification.queue.ts) `inspect`, [notification.repository.ts](../src/modules/notification/notification.repository.ts) `findManyWithAttempts`, [validate.ts](../src/grpc/validate.ts) path prefix, [metrics.service.ts](../src/utils/metrics/metrics.service.ts) `chub_bulk_targets`
- Tests: [bulk-targets.spec.ts](../src/modules/notification/bulk-targets.spec.ts), [app.e2e-spec.ts](../test/app.e2e-spec.ts)
- Docs: [API_GUIDE.md](API_GUIDE.md) bulk section, [10-track-retry-cancel-bulk.http](http/10-track-retry-cancel-bulk.http)

**Stack:** TypeScript, NestJS 12, gRPC with an in-process HTTP gateway, Postgres / TypeORM, Redis, BullMQ, Docker; a modular monolith with API and worker roles.

**How it was checked:** read every changed file line by line, followed the calls the change depends on (`FieldCipher.blindIndex`, `normaliseRecipient`, the BullMQ and Redis connection options), and ran the tools below.

| Check | Result |
| --- | --- |
| Typecheck (`tsc --noEmit`) | Clean |
| Unit tests | 132 passed (11 files) |
| End-to-end tests | 65 passed (6 files) |
| oxlint (`--type-aware`) | No warnings in the changed lines. Two `no-misused-spread` warnings at `notification.service.ts:148` and `:160` are in older code (L13). |
| Prettier | Flags all 9 changed source and test files (L7, still open) |
| `npm audit --omit=dev` | 8 advisories (3 High, 1 Moderate, 4 Low), none introduced by this change ([§4](#4-security-findings)) |

---

## 1. Executive summary

**Overall verdict: PASS WITH COMMENTS.**

The round 1 fixes are in and they work:
- The bulk logic now lives in `NotificationService.sendBulk`. The controller only decodes.
- The key suffix is the keyed per-tenant blind index. It no longer leaks recipients to anyone holding a database dump.
- Errors name the client's item.
- Keys that are too long for the list form get a clear error.
- Repeated compiles and the per-notification replay queries are gone.

The tests cover the new behaviour, and everything passes.

Round 2 found one **High** issue, which predates this change: when Redis is unreachable, a send request **hangs** instead of degrading as the code comments promise (H1). The bulk path makes it more serious: up to 500 rows are committed, the client times out, and a client that retries without an idempotency key sends everything again. It should be fixed next, as its own change.

The new **Medium** issues:
- M6: the switch to the keyed hash changes every derived key once, on deploy. A future `BLIND_INDEX_KEY` rotation would do the same.
- M7: bulk validation now stops at the first invalid item instead of reporting all of them.

| Severity | Round 1 (all addressed) | Round 2 (new) |
| --- | --- | --- |
| Critical | 0 | 0 |
| High | 0 | 1 (predates this change) |
| Medium | 5 | 2 |
| Low | 7 (L7 still open) | 6 |

### Round 1 findings and their status

| # | Sev. | Finding (2026-10-28) | Status (2026-10-30) |
| --- | --- | --- | --- |
| M1 | Medium | The key suffix was an unkeyed SHA-256 of the recipient, so a DB dump could recover phone numbers by brute force | **Fixed.** The suffix is the first 16 hex characters of `FieldCipher.blindIndex` (HMAC-SHA-256, per tenant), the same value as `recipient_hash`. The caller passes the hash in (`TargetHash`). |
| M2 | Medium | Validation errors used the expanded index | **Fixed.** `notifications.<i>…` or `notifications.<i>[<j>]…`; `validateInput` takes a path prefix. See L8 for what `<j>` counts. |
| M3 | Medium | Keys of 239–255 characters broke on list-form items | **Fixed.** `LIST_KEY_MAX` = 238, with an explicit message. Unit and end-to-end tests at 238 / 239. |
| M4 | Medium | One Handlebars compile per item; 2 × N sequential Redis reads; one replay query per notification | **Fixed / reduced.** One compile per distinct text. `inspect` sends both commands concurrently. Replay history comes from one `IN (…)` query. Still 2 Redis commands per notification (BullMQ 6 has no batch getter). |
| M5 | Medium | Business logic in the controller | **Fixed.** `NotificationService.sendBulk(tenantId, items)`; shared `invalid()` helper. |
| L1 | Low | `T[] \| string` return type | **Fixed.** `ExpandResult<T>` is a discriminated union. |
| L2 | Low | Two forms for one concept; push tokens split on commas | **Fixed.** The comma form is email / SMS only; the API guide recommends `recipients` and documents the key rule. |
| L3 | Low | `recipients` / `user_ids` on the shared `NotificationInput` | **Fixed.** `BulkNotificationInput` with the same field numbers (wire compatible); 16 / 17 reserved on `NotificationInput`. |
| L4 | Low | Missing tests | **Fixed.** End-to-end: both lists in one item, 238 / 239 key, client item index. Unit: push token with a comma, key limit. |
| L5 | Low | No metric for split size | **Fixed.** Histogram `chub_bulk_targets`, buckets 1–500. |
| L6 | Low | A derived key could collide with a client key `x:<16 hex>` | **Fixed (documented).** The keyed suffix can't be predicted; the API guide tells clients to avoid that shape. |
| L7 | Low | Prettier drift | **Open by design.** 120 files fail across the repo (`printWidth` 80 against code written about 150 wide). Reformat in its own commit. |

---

## 2. Findings (round 2)

### Critical Issues

No issues found.

### High Priority Issues

| # | Issue | Where | Impact | Risk | Fix |
| --- | --- | --- | --- | --- | --- |
| H1 | **A send request hangs while Redis is unreachable.** The BullMQ connection uses `maxRetriesPerRequest: null`, and ioredis keeps its offline queue on by default. So `queue.enqueue(...)` and `queue.inspect(...)` neither resolve nor reject during an outage; they wait for the reconnect. The `try/catch` around the enqueue ("the request succeeds even if the queue push fails … the sweeper enqueues them later") and the `catch` in `queueState` ("never fails the request") don't run. Predates this change, but this change put 2 × N `inspect` calls on the bulk response path. | [queue.module.ts:53-64](../src/utils/queue/queue.module.ts#L53-L64), [notification.service.ts:202-209](../src/modules/notification/notification.service.ts#L202-L209), [:225-228](../src/modules/notification/notification.service.ts#L225-L228) | Rows are committed, but the client gets a deadline error, not a 202. A client retrying **without** an idempotency key creates every notification again (up to 500 per bulk request). Each hung request also leaves up to 1,000 commands in the offline queue, and they all run at once when Redis comes back. | Duplicate sends and a surge of commands when Redis recovers, during any Redis incident | Put a timeout on both calls in the request path (enqueue about 2 s, inspect about 0.5 s). Or read queue state through a connection with `enableOfflineQueue: false`, so reads fail fast. Workers keep `maxRetriesPerRequest: null` (BullMQ requires it there). See [§7](#7-suggested-improved-code). |

*Found by reading the connection options; not reproduced against a stopped Redis. A quick way to confirm it: stop Redis, then `POST /v1/notifications`.*

### Medium Issues

| # | Issue | Where | Impact | Risk | Fix |
| --- | --- | --- | --- | --- | --- |
| M6 | **Derived keys change when this ships, and on every `BLIND_INDEX_KEY` rotation.** The suffix used to be `sha256(target)`; now it is `HMAC(BLIND_INDEX_KEY, tenant ‖ target)`. | [notification.service.ts:99](../src/modules/notification/notification.service.ts#L99), [field-cipher.ts:112-113](../src/utils/crypto/field-cipher.ts#L112-L113) | If `2622d77` / `7d5395c` is already deployed, a client that repeats a bulk request across this deploy re-sends to every list-form target. Rotating the blind-index key later does the same, silently. Neither is documented. | Duplicate SMS or email, once per deploy or rotation | If the old version is live, deploy at a quiet time or announce a short window. Add a line to the key-rotation runbook: rotating `BLIND_INDEX_KEY` resets bulk idempotency for keys in flight (and needs the `recipient_hash` backfill anyway). |
| M7 | **Bulk validation stops at the first invalid item.** Before the fix, one `validateInput(SendBulkNotificationDto, …)` call reported every invalid item. Now `flatMap` throws on the first failing item or target. | [notification.service.ts:100-105](../src/modules/notification/notification.service.ts#L100-L105) | A 500-target request with 30 bad numbers takes 30 round trips to fix. This is a change to the bulk error contract that the API guide doesn't mention. | Client friction; support tickets | Collect the messages of all items and throw once, capped at about 50 messages to bound the response size. See [§7](#7-suggested-improved-code). |

### Low Priority Issues

| # | Issue | Where | Fix |
| --- | --- | --- | --- |
| L8 | **`[<j>]` counts distinct targets, not the client's list.** The comma `recipient` comes first and duplicates are dropped, so `recipients: ["+1…00", "+1…00", "bad"]` reports `notifications.0[1]`, while the client's index is `recipients[2]`. The API guide says "distinct target", which is accurate but hard to act on. | [bulk-targets.ts:99-101](../src/modules/notification/bulk-targets.ts#L99-L101), [notification.service.ts:104](../src/modules/notification/notification.service.ts#L104) | Carry each target's source (`recipient`, `recipients[k]`, `userIds[k]`) through `unique()` and report `notifications.0.recipients[2]`. |
| L9 | **Items are decoded before the size check.** The controller runs `decodeInput` (`Struct.decode` of `data`, `Timestamp`, map copy) on every item, and only then does the service count targets. In round 1, an oversized request was rejected before any per-item work. | [notification.controller.ts:147](../src/modules/notification/notification.controller.ts#L147) | The cost is linear and bounded by the 5 MB / 8 MB body limits, so it is not a DoS. If it matters, pass `decodeInput` into `sendBulk` and decode after `countTargets`, which only needs `channel` and the target fields. |
| L10 | The empty-request message reads "notifications must contain at least 1 elements" (copied from class-validator's wording). | [notification.service.ts:90](../src/modules/notification/notification.service.ts#L90) | "notifications must contain at least one item". |
| L11 | **No unit test for `NotificationService.sendBulk`.** The size cap, the error paths, the metric and the compile deduplication are covered only end to end (or not at all: nothing shows that a broken template in item 2 is still caught when item 1 has the same text). | [notification.service.ts:89-110](../src/modules/notification/notification.service.ts#L89-L110) | A service spec with a mocked repository and queue: the 500 cap, the 501st target, error paths, and that `renderText` runs once per distinct text. |
| L12 | `decodeInput` now takes `ProtoBulkNotificationInput` for single sends too. gRPC drops fields 16 / 17 on `SendNotification`, so this is harmless, but the type no longer documents what single send accepts. | [notification.controller.ts:57](../src/modules/notification/notification.controller.ts#L57) | Make it generic: `decodeInput<T extends ProtoNotificationInput>(input: T)`. |
| L13 | oxlint `no-misused-spread` at `notification.service.ts:148` and `:160` (`{ ...n }` on an entity). Outside the diff. | [notification.service.ts:148](../src/modules/notification/notification.service.ts#L148) | Return a plain projection, or ignore the rule on that line with a reason. |

---

## 3. Category review

| # | Category | Result |
| --- | --- | --- |
| 1 | Security | H1 (availability), M6. Injection, XSS, SSRF, path traversal, deserialization, authentication / authorization: **No issues found** ([§4](#4-security-findings)). |
| 2 | Architecture | **No issues found.** The controller is transport-only again. `bulk-targets.ts` is pure, and the hash is injected (`TargetHash`), so the module has no crypto or DI dependency. No circular imports, dead code or unused imports; `SendBulkNotificationDto` was removed along with its last use. |
| 3 | Performance | L9. Otherwise improved ([§5](#5-performance-findings)). |
| 4 | Time complexity | [§6](#6-complexity-analysis) |
| 5 | Space complexity | [§6](#6-complexity-analysis). Bounded at O(500) beyond the parsed body. |
| 6 | Database | **No issues found.** No schema change or migration. `findManyWithAttempts` is tenant-scoped, uses `IN (…)` on the primary key with at most 500 ids, and loads relations in one query. `INSERT … ON CONFLICT DO NOTHING` still handles concurrent duplicate keys. |
| 7 | API | M6, M7, L8, L10. The proto change is wire compatible (same field numbers; 16 / 17 reserved). Typed clients that regenerate stubs get a new message name; this is documented. Status 202, idempotent per target. |
| 8 | Naming | L10. Otherwise **No issues found**: `LIST_KEY_MAX`, `KEY_SUFFIX_HEX`, `COMMA_LIST_CHANNELS`, `TargetHash`, `ExpandResult`, `isCommaList`, `findManyWithAttempts`, `chub_bulk_targets` are clear and follow the codebase's conventions. |
| 9 | Code quality | **No issues found.** Short functions with shallow nesting; `invalid()` removed 4 duplicated blocks. The ternary that picks `[field, targets]` in `expandBulkItem` is the densest line, and its comment explains it. |
| 10 | Error handling | H1, M7. The global handler maps `VALIDATION_ERROR` to gRPC `INVALID_ARGUMENT` / HTTP 400 without leaking internals. |
| 11 | Logging | **No issues found.** No new log lines; existing ones mask recipients; the request ID still reaches the jobs. |
| 12 | Validation | M7, L8. Each expanded target passes the full `SendNotificationDto` rules (`whitelist`, `forbidUnknownValues`). Key length and the total of 500 targets are checked before any per-target allocation. |
| 13 | Concurrency | **No issues found.** The fan-out is pure. `inspect` reads the job and its state concurrently; the state may be read a moment before or after the job, which is harmless for a status snapshot. Concurrent duplicate keys are settled by the unique constraint. |
| 14 | Dependencies | **No issues found** in this change (no new packages). Existing advisories in [§4](#4-security-findings). |
| 15 | Testability | L11. The helpers are pure (10 unit tests); end-to-end tests cover the fan-out, replay, a list growing under one key, the 500 cap, key length, error paths and single-send rejection. |
| 16 | Observability | **No issues found.** `chub_bulk_targets` plus the existing accepted / replayed counters. Health, readiness and tracing are unaffected. |
| 17 | Scalability | H1. Stateless; one insert and one enqueue per channel per request; template and From lookups are shared across the request. |
| 18 | Production readiness | H1, M6. Config, secrets and shutdown are unaffected. |
| 19 | Linting / standards | L7 (Prettier), L13 (oxlint, outside the diff). |

---

## 4. Security findings

| Area | Severity | Result |
| --- | --- | --- |
| SQL / NoSQL / command injection, path traversal, XXE, SSRF, open redirect, insecure deserialization, file upload | — | **No issues found.** TypeORM parameterises queries (`In(ids)` included); the change has no file, URL or shell handling. |
| XSS / output encoding | — | **No issues found.** Inline subject / body pass through the same Handlebars path as before. |
| Authentication, authorization, access control | — | **No issues found.** The tenant comes from `x-api-key`; the blind index and `findManyWithAttempts` are both tenant-scoped. |
| JWT, sessions, cookies, CSRF, CORS, security headers | — | Not affected. **No issues found.** |
| Secrets, hard-coded credentials | — | **No issues found.** The HMAC key comes from `BLIND_INDEX_KEY`. |
| Sensitive data exposure | — | **No issues found.** The derived key now reveals only a 64-bit prefix of the per-tenant HMAC that `recipient_hash` already stores; brute-forcing it needs the server key. (M1 closed.) |
| Input validation | — | L8 (error paths only). Limits are enforced before allocation. |
| Rate limiting | Low | The per-tenant throttle counts requests, not targets, so one request does up to 500× the work. Accepted: the size check runs first. |
| Availability | **High** | H1: requests hang, and keyless retries duplicate sends, while Redis is down. |
| Exception handling, information leakage | — | **No issues found.** |
| Dependencies (outside this change) | High | `npm audit --omit=dev`: body-parser 2.0.0–2.3.0 and multer 2.0.0–2.4.0 (High, DoS); nodemailer ≤ 10.1.3 (Moderate: addressparser can turn display text into extra recipients, which matters because `from` accepts display names); deepmerge (prototype pollution). Run `npm audit fix` in a separate change. |

## 5. Performance findings

Since round 1:

| What | Round 1 | Now |
| --- | --- | --- |
| Inline template compiles, 500-target item with a 50 KB body | 500 compiles | 1 compile |
| Redis reads for the response | 2 per notification, one after the other | 2 per notification, sent concurrently (about 1 round trip of latency; still 1,000 commands for 500 targets) |
| Replay history | 1 query per replayed notification | 1 query in total |
| Size check | Before decode | After decode (L9; linear and bounded) |

`expandBulkItem` copies objects shallowly, so `body` and `data` are shared, not duplicated. The `compiled` set holds references to strings that already exist, not copies.

Remaining opportunity: the response's queue state could be skipped for bulk requests (or made opt-in), since a bulk client usually polls later anyway. That would remove 1,000 Redis commands per 500-target request and make H1 smaller.

## 6. Complexity analysis

T = targets after fan-out (≤ 500); I = items in the request; r, u = recipients and userIds in one item; |s| = length of a comma-separated `recipient`; |b| = body size; D = distinct subject / body texts.

| Function | Time (best / average / worst) | Space | Suggested |
| --- | --- | --- | --- |
| `countTargets()` | O(1) / O(1) / O(\|s\|) (comma scan, email / SMS only) | O(1) | Fine as is |
| `unique()` | O(n) / O(n) / O(n) | O(n) Set | Fine as is |
| `expandBulkItem()` | O(1) plain item / O(r+u) / O(r+u), plus one HMAC per target when a key is set | O(r+u) shallow copies | Fine as is |
| `sendBulk()` (service) | O(I + Σ\|s\|) size check, then O(T) fan-out and validation | O(T) | Collect errors instead of failing fast (M7); same complexity |
| `sendBulk()` (controller) | O(I · \|data\|) decode, before the size check | O(I) | Decode after the size check (L9) |
| `validate()` | O(D·\|b\| + T) (was O(T·\|b\|)) | O(T + D) | Fine as is |
| `insertIdempotent()` | O(T): one INSERT plus indexed lookups | O(T) | Fine as is |
| `findManyWithAttempts()` | O(R + attempts) for R replays, one query | O(R + attempts) | Fine as is |
| Queue state in the response | 2T Redis commands, about 1 round trip of latency | O(T) | Skip it for bulk, or bound it with a timeout (H1) |

## 7. Suggested improved code

### H1: bound Redis calls on the request path

```ts
// notification.service.ts
/** Rejects when `promise` hasn't settled within `ms`; the operation itself keeps running. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// sendMany: the existing catch now runs during an outage; the sweeper enqueues later.
await withTimeout(this.queue.enqueue(inserted, requestId, (n) => policies.get(n as Notification)), 2_000, 'enqueue');

// queueState
return await withTimeout(this.queue.inspect(n, this.maxAttempts), 500, 'queue state');
```

A late enqueue still completes when Redis returns. The job id is the notification id, so it can't duplicate the sweeper's job (`ensureEnqueued` checks for an existing job). For reads, a dedicated connection with `enableOfflineQueue: false` is better still: commands fail at once instead of queueing up.

### M7: report every invalid item

```ts
// grpc/validate.ts: the non-throwing form validateInput builds on
export function validationErrors<T extends object>(cls: Type<T>, plain: object, path = ''): { dto: T; errors: string[] } {
  const dto = plainToInstance(cls, plain);
  return { dto, errors: messages(validateSync(dto, { whitelist: true, forbidUnknownValues: true }), path) };
}
```

```ts
// NotificationService.sendBulk
const errors: string[] = [];
const dtos: SendNotificationDto[] = [];
items.forEach((item, i) => {
  const expanded = expandBulkItem(item, hashTarget);
  if (!expanded.ok) return void errors.push(`notifications.${i}: ${expanded.error}`);
  const several = expanded.items.length > 1;
  expanded.items.forEach((target, j) => {
    const result = validationErrors(SendNotificationDto, target, several ? `notifications.${i}[${j}]` : `notifications.${i}`);
    if (result.errors.length) errors.push(...result.errors);
    else dtos.push(result.dto);
  });
});
if (errors.length) {
  const shown = errors.slice(0, MAX_REPORTED_ERRORS); // e.g. 50
  throw new AppException(ERROR.VALIDATION_ERROR, { errors: shown }, { detail: shown[0] });
}
```

### L8: name the client's own list index

```ts
// bulk-targets.ts: keep where each target came from
type Sourced = { value: string; source: string }; // "recipient", "recipients[2]", "userIds[0]"
const fromRecipient = base.recipient ? (commaList ? base.recipient.split(',') : [base.recipient]).map((value) => ({ value, source: 'recipient' })) : [];
const fromList = recipients.map((value, k) => ({ value, source: `recipients[${k}]` }));
// unique() keeps the first source of each value; the service builds the path as `notifications.${i}.${source}`.
```

## 8. Code smells and refactoring opportunities

**Code smells**
- Comments that promise more than the code does: "never fails the request" and "the request succeeds even if the queue push fails" (H1).
- An error index that counts something the client never sees (L8).
- A shared decode type that blurs the single-send and bulk contracts (L12).

**Refactoring opportunities**
- Wrap Redis calls on the request path in one helper with a timeout (H1).
- Split `validateInput` into a throwing and a non-throwing form, so bulk can collect errors (M7).
- Make the response's queue state opt-in for bulk ([§5](#5-performance-findings)).
- Reformat the repo with Prettier in its own commit (L7).

## 9. Final review scorecard

| Area | Round 1 | Round 2 |
| --- | --- | --- |
| Security | ★★★★☆ | ★★★★☆ |
| Performance | ★★★★☆ | ★★★★☆ |
| Scalability | ★★★★☆ | ★★★★☆ |
| Readability | ★★★★☆ | ★★★★☆ |
| Maintainability | ★★★☆☆ | ★★★★☆ |
| Architecture | ★★★☆☆ | ★★★★★ |
| Code quality | ★★★★☆ | ★★★★☆ |
| Testing | ★★★★☆ | ★★★★☆ |
| Documentation | ★★★★☆ | ★★★★★ |
| Production readiness | ★★★★☆ | ★★★☆☆ (H1 found in this round; it predates the change) |

## 10. Final recommendation

**Approve: YES, with comments.**

Why:
- Every round 1 finding is addressed and covered by tests.
- No Critical issues, and no High issue introduced by this change.
- The typecheck and all 132 unit and 65 end-to-end tests pass.

The one High issue (H1) is older than this change, so holding the PR wouldn't remove it. It does need a ticket and a fix before the next large campaign, because bulk raises its cost.

Follow-ups, in order:
1. **H1**: timeouts on enqueue and queue reads in the request path.
2. **M6**: check whether the old key derivation is live, then plan the deploy and add the rotation note to the runbook.
3. **M7**, with **L8**: collect all validation errors, and report the client's own list index.
4. **L11**: a service-level spec for `sendBulk`.
5. The other Low items, and the Prettier reformat (L7) in its own commit.
