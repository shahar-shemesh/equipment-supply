<!-- Moved out of README.md on 2026-10-04. The README keeps the entry-level summary; this file is the reference. -->

# API

All routes are under `/api` and need `Authorization: Bearer <token>` except login.

| Route | Role | What |
| --- | --- | --- |
| `POST /auth/login`, `GET /auth/me`, `GET /auth/dev-accounts` | | development login; the user object carries `id` next to the JWT's `sub` |
| `GET /issuances`, `GET /issuances/:id`, `GET /issuances/summary` | manager | board (`?sort=number|customer|destination|city|courier|priority|status&order=asc|desc`, filters, paging), detail, the cities widget |
| `PATCH /issuances/:id` | manager | priority, delivery date, notes, self pickup |
| `POST /issuances/assign`, `POST /issuances/mark-urgent` | manager | bulk actions |
| `DELETE /issuances/:id` | manager | soft delete with a reason |
| `GET /couriers` | manager | couriers with their open task count |
| `POST /couriers`, `PATCH /couriers/:id` | manager | add / edit (name, id number, phone); a deleted courier with the same id number comes back on add |
| `DELETE /couriers/:id`, `POST /couriers/remove` | manager | soft delete (`active=false`), 409 with the names when one of them has open deliveries |
| `GET /delivery/tasks`, `GET /delivery/tasks/:id` | courier | my tasks (`?tab=all|pending|done&search=`) |
| `POST /delivery/tasks/:id/attempts` | courier | the delivery report (`IAttemptPayload`), optionally with `operation_id` (then `issuance_revision` is required), `client_reported_at`; answers `IAttemptResult` |
| `POST /delivery/tasks/:id/conflicts` | courier | a report the attempts route refused with a 409, kept as evidence; same body with a required `operation_id`; answers `IConflictReceipt`, or the delivery result when that operation had been applied |
| `GET /delivery/conflicts?operation_ids=` | courier | the review status of the caller's own evidence (`IConflictStatus[]`) |
| `GET /conflicts`, `GET /conflicts/:id` | manager | rejected reports (`?status=pending|reviewed|all&page=&page_size=`, no signatures in the list), one report with its signature next to the current state |
| `POST /conflicts/:id/review` | manager | `{ note, version }`: mark reviewed; 409 `review_conflict` with the existing review when another manager got there first |
| `GET /delivery/lookup?number=` | courier | find my task by the printed number |

## API contract changes

Made for the offline work, in `shared/@core.ts`:

- `POST /delivery/tasks/:id/attempts` accepts three optional fields. `operation_id`: 8 to 64 characters of letters, digits, `_` or `-`, else 400; with it the request is idempotent as described under [Rules enforced on the server](domain.md#rules-enforced-on-the-server), and `issuance_revision` becomes required: an offline operation may not skip the concurrency token by leaving it out (400), only the legacy request without any operation id may, and that one is decided by the task state alone. `issuance_revision`: an integer, else 400; it must match the current `issuances.revision`, else 409 `revision_changed`. `client_reported_at`: a strict ISO 8601 string, stored on the attempt as `client_reported_at`; anything else is stored as null, never a 400.
- `POST /delivery/tasks/:id/conflicts`, `GET /delivery/conflicts`, `GET /conflicts`, `GET /conflicts/:id` and `POST /conflicts/:id/review` are new, see [Unresolved reports](offline-sync.md#unresolved-reports). The shared types are `IConflictReceipt`, `IConflictStatus`, `IDeliveryConflict`, `IConflictObserved`, `ConflictReviewStatus` and, client side only, `EvidenceUploadState`. `ReportConflictCode` gained `not_a_conflict`, returned only by the conflicts route.
- The success body is `IAttemptResult`: `{ attempt_id, outcome, task_id, reported_at, operation_id? }`, a superset of the old `{ attempt_id, outcome }`, still 201. A replay of a stored operation returns the stored body plus `replayed: true`.
- Every 409 of that route is `{ statusCode: 409, message, code }` with `code` from `ReportConflictCode` (`task_closed`, `task_cancelled`, `issuance_not_assigned`, `revision_changed`, `operation_reused`). The default Nest `error` field is gone from these bodies; `message` and `statusCode` stay. The legacy request without an operation id still answers 409 with the message `task already closed`, now with `code: task_closed`.
- `POST /auth/login` returns `user: { id, sub, username, display_name, role, courier_id }` and `GET /auth/me` returns `{ id, ...jwt payload }`: `id` is `users.id`, the same value as `sub`, so the client never keys its local storage on an undefined id. The client also fills `id` from `sub` for a session stored before this change.
- `IIssuance.revision`, `IDeliveryAttempt.client_reported_at` and the client only `IDeliveryTask.local_report` were added to the shared types.

Nothing else in the API changed.
