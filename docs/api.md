<!-- Moved out of README.md on 2026-10-04. The README keeps the entry-level summary; this file is the reference. -->

# API

All routes are under `/api` and need `Authorization: Bearer <token>` except login.

| Route | Role | What |
| --- | --- | --- |
| `POST /auth/login`, `GET /auth/me`, `GET /auth/dev-accounts` | | development login; the user object carries `id` next to the JWT's `sub` |
| `GET /issuances`, `GET /issuances/:id`, `GET /issuances/summary` | manager | board (`?sort=number|customer|destination|city|courier|priority|status&order=asc|desc`, filters, paging; `status`, `priority` and `city` also take a comma list, `status=assigned,delivered` is an `IN`), detail, the cities widget (`by_city` counts the `unassigned` rows of every city, all dates, a city with none is not listed; `cities` is every live city for the filter) |
| `PATCH /issuances/:id` | manager | priority, delivery date, notes, self pickup |
| `POST /issuances/assign`, `POST /issuances/mark-urgent` | manager | bulk actions. `assign` is all or nothing: one row the transition table refuses answers 409 `status_not_allowed` (`sap_number`, `status`, `action` in the body, see [Status transitions](domain.md#rules-enforced-on-the-server)) and nothing is written; `mark-urgent` skips the rows it may not touch and answers the count |
| `POST /issuances/:id/self-pickup/report` | manager | the handover at the warehouse of a `self_pickup` issuance: the courier's report body (`IAttemptPayload` without the offline fields), checked by the same validators; answers the issuance as `GET /issuances/:id` does, 201; 409 from any other status, a second report included |
| `DELETE /issuances/:id` | manager | soft delete with a reason |
| `DELETE /issuances/:id/items/:itemId` | manager | one line off the issuance, soft (the row keeps `removed_at`, past attempts keep their reference), from the statuses of the edit row; the open task stays and `revision` moves; answers the issuance as `GET /issuances/:id` does, 200; 404 for a line that is not live on that issuance, 400 for an id that is not a positive integer, 409 `last_item` (`sap_number` in the body) for the only line left, 409 `status_not_allowed` elsewhere |
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
| `GET /audit` | manager | the audit log as `IAuditPage { items, total }`, newest first; `?issuance_id=&actor_user_id=&action=&from=&to=&page=&size=` (`page` 1-based, `size` default 50 and at most 100, `from` / `to` an ISO date or date time read as UTC, `to` exclusive and a bare date covering its whole day); a value that is not what the parameter means is a 400, never an empty page |
| `GET /xml-export` | manager | the xml export outbox as `IXmlExportOverview { counts, failed }`: `counts` by status plus `retry_waiting` (pending rows whose retry time is still ahead) and `lease_expired` (processing rows a worker left behind), and the failed rows (`IXmlExportEvent`, oldest first, at most 100) with their `last_error`; see [XML export](xml-export.md#investigating-and-retrying) |
| `POST /xml-export/:id/retry` | manager | a failed row goes back to the queue (`pending`, `attempts` 0, lease and error cleared), answers the row as `IXmlExportEvent`, 201; 409 `{ statusCode: 409, message, code: 'not_failed', status }` for a row that is not failed, 404 for an unknown id, 400 for a value that is not a uuid; writes an `xml_export.retry` audit row |

## API contract changes

Made for the offline work, in `shared/@core.ts`:

- `POST /delivery/tasks/:id/attempts` accepts three optional fields. `operation_id`: 8 to 64 characters of letters, digits, `_` or `-`, else 400; with it the request is idempotent as described under [Rules enforced on the server](domain.md#rules-enforced-on-the-server), and `issuance_revision` becomes required: an offline operation may not skip the concurrency token by leaving it out (400), only the legacy request without any operation id may, and that one is decided by the task state alone. `issuance_revision`: an integer, else 400; it must match the current `issuances.revision`, else 409 `revision_changed`. `client_reported_at`: a strict ISO 8601 string, stored on the attempt as `client_reported_at`; anything else is stored as null, never a 400.
- `POST /delivery/tasks/:id/conflicts`, `GET /delivery/conflicts`, `GET /conflicts`, `GET /conflicts/:id` and `POST /conflicts/:id/review` are new, see [Unresolved reports](offline-sync.md#unresolved-reports). The shared types are `IConflictReceipt`, `IConflictStatus`, `IDeliveryConflict`, `IConflictObserved`, `ConflictReviewStatus` and, client side only, `EvidenceUploadState`. `ReportConflictCode` gained `not_a_conflict`, returned only by the conflicts route.
- The success body is `IAttemptResult`: `{ attempt_id, outcome, task_id, reported_at, operation_id? }`, a superset of the old `{ attempt_id, outcome }`, still 201. A replay of a stored operation returns the stored body plus `replayed: true`.
- Every 409 of that route is `{ statusCode: 409, message, code }` with `code` from `ReportConflictCode` (`task_closed`, `task_cancelled`, `issuance_not_assigned`, `revision_changed`, `operation_reused`). The default Nest `error` field is gone from these bodies; `message` and `statusCode` stay. The legacy request without an operation id still answers 409 with the message `task already closed`, now with `code: task_closed`.
- `POST /auth/login` returns `user: { id, sub, username, display_name, role, courier_id }` and `GET /auth/me` returns `{ id, ...jwt payload }`: `id` is `users.id`, the same value as `sub`, so the client never keys its local storage on an undefined id. The client also fills `id` from `sub` for a session stored before this change.
- `IIssuance.revision`, `IDeliveryAttempt.client_reported_at` and the client only `IDeliveryTask.local_report` were added to the shared types.

Made for the audit log, in `shared/@core.ts`:

- `GET /audit` is new, manager only, see the audit paragraph under [Rules enforced on the server](domain.md#rules-enforced-on-the-server) for what is recorded. The shared types are `AuditActorType`, `AuditAction` (the closed action list), `AuditEntityType`, `IAuditEntry` and `IAuditPage`. No other route changed its body or its status codes; `POST /issuances/mark-urgent` still answers `{ updated }` with the count of editable rows.

Made for the self pickup handover, in `shared/@core.ts`:

- `POST /issuances/:id/self-pickup/report` is new, manager only. The body is the courier's `IAttemptPayload` without `operation_id`, `issuance_revision` and `client_reported_at` (sent anyway they are ignored: the route is online only, there is no replay and no revision check). The outcome is derived from the item answers like a courier report and becomes the issuance status (`delivered`, `partially_delivered` or `not_delivered`) with `self_pickup` kept `true`; the attempt hangs off a new done task with `courier_id: null` and `assigned_by` the manager. The answer is the issuance as `GET /issuances/:id` returns it.
- `IIssuance` gained `delivered_by_user_id` (the manager who handed over, `users.id` from the token; null for every courier delivery) and `delivered_by_name` (derived, the display name the board shows where the courier would be). `IDeliveryTask.courier_id` is now `number | null`. `AuditAction` gained `issuance.self_pickup_report`.
- `GET /issuances` and `GET /issuances/:id` answer `current_task: null` and `delivered_by_name: null` while the status is `self_pickup`, whatever closed tasks the issuance has: the courier side ended and the handover is ahead. The `courier` sort key is null for those rows too, and the manager's name for a handed over row, so the sort and the column agree.

Made for the line removal, in `shared/@core.ts`:

- `DELETE /issuances/:id/items/:itemId` is new, manager only, see the table above. Its own 409 is `{ statusCode: 409, message, code: 'last_item', sap_number }`; the status refusal is the usual `status_not_allowed` body with `action: 'remove_item'`. `IssuanceAction` in `shared/@rules.ts` gained `remove_item`, `AuditAction` gained `issuance.remove_item`, `IIssuanceItem` gained `removed_at` (null on every line a response lists; a removed line is returned in one place only, `GET /conflicts/:id`, whose issuance lists the lines as the refused report knew them, the removed ones with `removed_at` set, so the review can name the line in dispute).
- `POST /delivery/tasks/:id/attempts` validates a report whose `issuance_revision` is behind the current one against the live lines plus the removed ones it names (not every removed line: a snapshot taken between two removals never knew the earlier one), so a report signed against the old line set reaches the lock and is answered as a replay or refused as 409 `revision_changed` with its evidence intact, instead of a 400 `unknown item`. A report at the current revision is validated against the live lines only as before. A report without a revision (no `operation_id`) is validated the same way and is also held, under the lock, to the revision it was validated against: a removal that committed in between is a 409 `revision_changed` there too.
- `POST /issuances/:id/self-pickup/report` answers 409 `{ statusCode: 409, message, code: 'revision_changed', sap_number }` when the issuance revision moved between its validation and its lock (a line removed by another manager); the detail dialog reloads on it.

Made for the xml export, in `shared/@core.ts`:

- `GET /xml-export` and `POST /xml-export/:id/retry` are new, manager only, see the table above and [XML export](xml-export.md). The shared types are `XmlOutboxStatus`, `IXmlExportEvent` and `IXmlExportOverview`; `AuditAction` gained `xml_export.retry`.
- No existing route changed: the five status writing routes (`POST /issuances/assign`, the self pickup move of `PATCH /issuances/:id`, `DELETE /issuances/:id`, `POST /issuances/:id/self-pickup/report`, `POST /delivery/tasks/:id/attempts`) write an `xml_outbox` row inside their transaction and answer exactly as before, same bodies and same status codes.

Nothing else in the API changed.
