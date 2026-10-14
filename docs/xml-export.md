# XML export of issuance status changes

Every committed change of an issuance's status leaves the system as one XML document in an S3 bucket, for the SAP side. The handoff is the object in the bucket: once it is there the system's part is done, and no consumer acknowledgement exists or is waited for. What SAP will do with the documents, and the final shape of the document itself, are not written yet (see [The contract is provisional](#the-contract-is-provisional)).

Back to [README](../README.md). The server rules and the schema are in [domain.md](domain.md), the two manager endpoints in [api.md](api.md). The plan with its decisions is `docs/plans/xml-export-outbox.md`.

## Architecture

A transactional outbox, nothing else: no queue, no scheduler package, one new dependency (`@aws-sdk/client-s3`).

- **The row.** Each of the five transactions that write an issuance status (`assign`, the self pickup move of `PATCH /issuances/:id`, `DELETE /issuances/:id`, the handover `POST /issuances/:id/self-pickup/report`, the courier's `POST /delivery/tasks/:id/attempts`) inserts one `xml_outbox` row on its own `EntityManager`, right after the audit row, inside the same transaction. The change and its row commit or roll back together: a request that fails after the status write leaves no row, a committed one always has one. The insert takes no lock; the lock order of the services (issuance, then task) is untouched. `XmlOutboxService.record` is the one writer (`server/src/xml-export/xml-outbox.service.ts`) and it writes nothing when the status did not move (a reassign of an assigned issuance), so the guard is not repeated at the call sites. Nothing is written for edits, mark urgent, a line removed, a replayed report, the seed or any refused request.
- **The payload is a snapshot.** The row holds everything the document needs: seven fields of the issuance as it is after the change (`id`, `sap_number`, `number_prefix`, `priority`, `delivery_date`, `self_pickup`, `revision`), the actor from the token, the trigger (the audit action of the same change) and a few ids and counts. The worker never reads `issuances`, so a row reads the same after the issuance moved on or was deleted. No customer name, id number, phone, address, note, recipient or signature goes in: the keys are dropped at write time and again by the builder.
- **Sequence.** `sequence` counts the rows of one issuance (1, 2, 3...) in commit order; `(issuance_id, sequence)` is unique. The ids are uuids and say nothing about order.
- **The worker** (`xml-export.worker.ts`) runs inside the NestJS process when `XML_EXPORT_ENABLED=true`: every `XML_EXPORT_POLL_MS` it claims a batch, and per row builds the document, uploads it and marks the row. Rows are written whether or not the worker is on: a backlog written before the bucket existed is exported once the flag turns on.
- **Storage** is two calls behind one interface (`xml-storage.ts`: `putIfAbsent`, `head`), and `XML_EXPORT_STORAGE` picks the backend once at startup. `s3-storage.service.ts` is the only file that imports the SDK: one client, `PutObject` with `If-None-Match: *` and `HeadObject`; credentials come from the SDK's default provider chain (environment, profile, instance or task role), nothing in the code reads a key. `local-xml-storage.service.ts` writes the same keys under a directory, for a laptop and the e2e suite (see [Local filesystem storage](#local-filesystem-storage)).

## The document

UTF-8, one element per line, an element whose value is null is absent (never empty). Provisional, see below.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<IssuanceStatusChange xmlns="urn:equipment-supply:issuance-status-change" schemaVersion="0.1-provisional">
  <EventId>a0d17000-0000-4000-8000-00000000000a</EventId>
  <Sequence>2</Sequence>
  <OccurredAt>2026-10-14T08:00:00.000Z</OccurredAt>
  <Issuance>
    <Id>12</Id>
    <SapNumber>7000001</SapNumber>
    <NumberPrefix>ס&apos;</NumberPrefix>
    <Priority>normal</Priority>
    <DeliveryDate>2026-10-20</DeliveryDate>
    <SelfPickup>false</SelfPickup>
    <Revision>3</Revision>
  </Issuance>
  <PreviousStatus>assigned</PreviousStatus>
  <NewStatus>delivered</NewStatus>
  <Trigger>delivery.report</Trigger>
  <Actor type="user">
    <UserId>4</UserId>
    <Username>c</Username>
    <Role>courier</Role>
  </Actor>
  <Details>
    <TaskId>9</TaskId>
    <AttemptId>3</AttemptId>
    <CourierId>2</CourierId>
    <ItemsDelivered>2</ItemsDelivered>
    <ItemsTotal>2</ItemsTotal>
  </Details>
</IssuanceStatusChange>
```

| Element | Meaning |
| --- | --- |
| `EventId` | the row's uuid, also in the object key and the object metadata |
| `Sequence` | the position of this change among the issuance's changes; a gap means a row failed and waits for a manager (see below) |
| `OccurredAt` | when the change was written, UTC |
| `Issuance` | the issuance after the change. `DeliveryDate` and `NumberPrefix` are absent when null |
| `PreviousStatus`, `NewStatus` | `IssuanceStatus` values: `unassigned`, `assigned`, `delivered`, `partially_delivered`, `not_delivered`, `self_pickup`, `deleted` |
| `Trigger` | the action: `issuance.assign`, `issuance.self_pickup`, `issuance.self_pickup_report`, `issuance.delete`, `delivery.report` |
| `Actor` | `type="user"` with `UserId`, `Username`, `Role` (`manager` or `courier`); `type="system"` with no children when there is no token (nothing writes such rows today) |
| `Details` | per trigger. Assign: `CourierId`, `TaskId`, `ScheduledDate`. Delete: `Reason`. Courier report: `TaskId`, `AttemptId`, `CourierId`, `OperationId`, `ItemsDelivered`, `ItemsTotal`. Handover: `TaskId`, `AttemptId`, `ItemsDelivered`, `ItemsTotal`. Self pickup: none (`<Details/>`) |

The object: key `<prefix>YYYY/MM/DD/issuance_<issuanceId>_<eventId>.xml` (the day from `OccurredAt`, UTC), content type `application/xml; charset=utf-8`, server side encryption `AES256` or `aws:kms` with `XML_EXPORT_KMS_KEY_ID`, metadata `event-id`, `issuance-id`, `sequence`, `content-sha256` (hex SHA-256 of the bytes sent, also kept on the row).

## The contract is provisional

**Nobody on the SAP side has seen this document.** The namespace, `schemaVersion="0.1-provisional"`, the element names and the trigger values are the system's own draft so the pipeline could be built and tested; the final contract is open decision 16 in the README, next to the older question of what SAP should hear about a self pickup, a removed line or a reassign that leaves the status `assigned` (today: nothing, the status did not move). Expect the document to change; the version attribute is there so a consumer can tell when it did. The serializer and the builder are the only two files to touch for that (`xml.ts`, `xml-builder.service.ts`), the rows already hold what a richer document would need except the customer, which was left out on purpose.

## Lifecycle of a row

```
pending ──claim──> processing ──put ok / 412 with matching head──> completed
   ^                   │
   │                   ├──transient error, attempts < max──> pending (next_retry_at = now + backoff)
   │                   ├──transient error, attempts = max──> failed
   │                   ├──document cannot be built, key held by another object──> failed
   │                   └──lease expired (worker died)──> claimed again by the next tick
   └──POST /api/xml-export/:id/retry (manager, attempts back to 0)── failed
```

- **Claim.** One statement: pending rows whose `next_retry_at` passed and processing rows whose `lease_until` passed, `FOR UPDATE SKIP LOCKED`, `LIMIT batch`, moved to `processing` with `attempts + 1` and a lease of `XML_EXPORT_LEASE_MS`. Two workers (two server processes on one database) never take the same row. A row is not claimed while an earlier sequence of the same issuance is `pending` or `processing`, so the documents of one issuance leave in order; a `failed` row does not block the later ones (the consumer sees the gap in `Sequence`, the manager's retry closes it). A tick claims in rounds until a claim comes back empty (at most 50 rounds), so a chain of changes of one issuance leaves in one tick. The `attempts` number of the claim fences every later update of the row (the lease renewal, the completion, the failure): a worker that lost its lease and finishes late matches nothing and drops the row (`lost` in the tick's log line), the worker that reclaimed it writes the outcome.
- **Upload.** Outside any database transaction: the lease is renewed from now (the rows of a batch go one after the other, the last of a slow batch must not run out of the lease of the claim), then build the document from the row, `PutObject` with `If-None-Match: *`, then `UPDATE ... SET status = 'completed' WHERE id = $1 AND status = 'processing' AND attempts = $2`.
- **412.** The key is taken. `HeadObject` reads the metadata: the row's own `event-id` means the object of an earlier attempt of this very row (the upload went through, the completion did not: a lost response, a process that died, a lease that ran out), and the row is completed without a second object, with the `content-sha256` the bucket holds. A different hash under the same event id means the document changed between the attempts (a new schema version, a payload edited by hand): the first rendering stays, the log says so. Another `event-id` under the key is a `key_collision`, failed for a manager.
- **Transient errors** (network, timeout, 5xx, 429) send the row back to `pending` with `attempts` counted and `next_retry_at = now() + backoff` (the database clock, the one the claim reads): 5s · 2^(attempts-1), capped at 15 minutes, ±50% jitter. The 400 / 403 / 404 family (`NoSuchBucket`, `AccessDenied`, a KMS key the role may not use) is retried the same way, logged with the word `config`: an operator fixes the bucket or the policy and the rows flow without a manual retry per row.
- **Failed** after `XML_EXPORT_MAX_ATTEMPTS` claims, at once when the document cannot be built from the payload (`last_error` starts with `xml:`), or on a key collision. A row with more claims than the limit allows (the limit was lowered) is failed at the claim without an upload. Failed rows stay in the table and in `GET /api/xml-export` until a manager retries them.
- **At least once, one artifact.** A row may be claimed and uploaded twice (a lease that expired, a lost response); the key is deterministic and the put is conditional, so the bucket holds one object per event. Nothing here is exactly once and the docs do not claim it.

## Configuration

All through `xmlExportConfig()` in `server/src/env.ts`, checked at startup by `assertSafeConfig` (the server refuses to start with `XML_EXPORT_ENABLED=true` and no bucket or region on the `s3` backend, or with an unknown `XML_EXPORT_STORAGE`, naming the variable) and logged as `xml export: off`, `xml export: s3 <bucket>/<prefix>` or `xml export: local <dir>`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `XML_EXPORT_ENABLED` | off | `true` starts the worker in this process. The outbox rows are written regardless |
| `XML_EXPORT_STORAGE` | `s3` | `s3` or `local`, chosen once at startup and never swapped at runtime: a failing bucket does not fall back to the directory, nor the other way round. Anything else refuses to start |
| `XML_EXPORT_LOCAL_DIR` | `./exports/xml` | the directory of the `local` backend, resolved against the working directory of the server process; created on the first put. Ignored with `s3` |
| `AWS_REGION` | | required with the worker on and the `s3` backend; the SDK reads the same variable |
| `XML_EXPORT_BUCKET` | | required with the worker on and the `s3` backend |
| `XML_EXPORT_PREFIX` | `issuance-status-changes/` | the folder inside the bucket: letters, digits, `.`, `_`, `-`, `/`, ending with `/`, no leading `/` and no empty, `.` or `..` segment; empty for the bucket root |
| `XML_EXPORT_POLL_MS` | 5000 | the tick, at least 1000 (every number here is at most 2147483647, the int4 and javascript timer limit) |
| `XML_EXPORT_BATCH` | 20 | rows per claim |
| `XML_EXPORT_LEASE_MS` | 60000 | how long a claim belongs to its worker, renewed before every upload; longer than the slowest upload (the request timeout is 15s after a 5s connection timeout, the SDK makes two attempts: at most 40s per put) |
| `XML_EXPORT_MAX_ATTEMPTS` | 20 | with the default backoff that is about three hours of retries before a row is failed (5s doubling to the 15 minute cap: nineteen waits of about 11,000s in all) |
| `XML_EXPORT_S3_ENDPOINT` | | an S3 compatible endpoint with path style addressing, for MinIO or LocalStack on a laptop. Unset means AWS |
| `XML_EXPORT_KMS_KEY_ID` | | encrypt with this KMS key (`aws:kms`); unset means `AES256` |

Credentials: the SDK's default chain. On AWS prefer a role (instance profile or task role); on a laptop a profile or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in the environment. No variable of the application holds a key and none should.

### IAM policy

The role of the server process needs to put objects under the prefix and to read their metadata for the 412 path; with a KMS key, to use the key. Nothing else: no list, no delete, no bucket wide read.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteAndHeadIssuanceStatusChanges",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::<bucket>/issuance-status-changes/*"
    },
    {
      "Sid": "EncryptWithTheExportKey",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:<region>:<account>:key/<key-id>"
    }
  ]
}
```

`s3:GetObject` is what `HeadObject` checks. Leave the second statement out when no key is set (`AES256` needs no KMS permission). Replace the prefix in the resource when `XML_EXPORT_PREFIX` is changed. A bucket policy that denies unencrypted puts is compatible: every put names its encryption.

## Worker model

One timer per server process (`setInterval`, unref'd so it never keeps a stopping process alive), one tick at a time (a tick in flight makes the next one a no-op), `onModuleDestroy` stops the timer and waits for the tick in flight so a row is not left mid upload. Several processes on one database are fine: the claim is the lock. There is no leader election and none is needed; two workers simply share the queue.

The worker never runs under jest (`XML_EXPORT_ENABLED` is blank in `src/e2e/setup-env.ts`); `xml-export.e2e.spec.ts` calls `tick()` on it against an in-memory storage, `xml-export-local.e2e.spec.ts` against a temporary directory through the `local` backend.

## Logs

Every outcome is one line with the event id, the issuance id, the sequence, the attempt and the duration, and the key and the category once an upload was tried: `xml export: event <uuid> issuance 12 sequence 2 attempt 1 completed, key ..., 180ms`. Transient failures are warnings, failed rows are errors, a tick that moved something logs its counts. Never the document body, never a customer field.

## Investigating and retrying

- `GET /api/xml-export` (manager): `counts` by status plus `retry_waiting` (pending rows whose `next_retry_at` is still ahead) and `lease_expired` (processing rows a worker left behind, reclaimed by the next tick), and the failed rows (oldest first, at most 100) with their `last_error`.
- `last_error` is `<category>: <message>`: `transient:` and `config:` for the storage, `xml:` for a payload that gives no document, `key_collision:` for a key held by another object, `attempts:` for a row failed at the claim.
- A failed row: fix the cause (the bucket, the policy, the key; for `xml:` look at `payload` in the table, a row written by the application should never get there), then `POST /api/xml-export/:id/retry`. The row goes back to `pending` with `attempts` at 0, the lease released, `last_error` cleared, and an `xml_export.retry` row in the audit log names the manager, the event and the previous error. Only a `failed` row is retried: 409 `not_failed` otherwise, 404 for an unknown id, 400 for a value that is not a uuid.
- The table itself, read only: `SELECT id, issuance_id, sequence, status, attempts, next_retry_at, lease_until, s3_key, last_error FROM xml_outbox WHERE status <> 'completed' ORDER BY created_at`. `payload` is the snapshot. Do not edit rows by hand while the worker runs; the retry endpoint exists for that. Completed rows are kept (the `s3_key` and `content_sha256` are the receipt); a retention policy is not written yet.
- The object in the bucket: its metadata `event-id` is the row's id, `content-sha256` the row's `content_sha256`.

## Local filesystem storage

For development and testing only: the same documents, the same keys, under a directory instead of a bucket, so the worker runs end to end on a laptop and a change to the document can be read off the disk. Not for a real environment: a directory has no bucket policy, no encryption at rest, no cross-process guarantee beyond the one filesystem, and nobody on the SAP side reads it.

**Enabling.** In `server/.env`:

```
XML_EXPORT_ENABLED=true
XML_EXPORT_STORAGE=local
# XML_EXPORT_LOCAL_DIR=./exports/xml
```

No region, no bucket, no credentials. The startup line says `xml export: local <absolute dir>`. The directory is created on the first put; `server/exports/` is git ignored, another directory is the developer's to keep out of git.

**Where the files are.** `<dir>/<prefix><YYYY>/<MM>/<DD>/issuance_<id>_<event uuid>.xml`, the row's `s3_key` relative to the directory (the column keeps its name whatever the backend). Next to each document a sidecar `<name>.xml.meta.json` holds what the bucket would hold as object metadata: `event-id`, `issuance-id`, `sequence`, `content-sha256`.

**Inspecting.** Assign an issuance on the board; within one tick the two files are there, `cat` the xml, `GET /api/xml-export` shows the row `completed` with the key. `sha256sum` of the file is the row's `content_sha256` and the sidecar's.

**Switching.** `XML_EXPORT_STORAGE` is read once at startup; change it and restart. A row completed under one backend is not exported again under the other: the outbox has no notion of the backend, the row is done. To move a backlog to the bucket, retry the rows (or reset them to `pending` by hand with the worker stopped) after the switch.

**Retries and what the categories mean here.** A taken name is the `precondition` category, exactly like a 412, and the head reads the sidecar's `event-id` with the sha recomputed from the bytes on disk (the sidecar is never trusted for the content). A document copied in by hand has no sidecar, so the head reports no event id and the row is failed with `key_collision:` for a manager, as a foreign object in the bucket would be. A missing directory is created by the first put; one that cannot be created or read, or that exists as a plain file, is `config:` and retried with the backoff until an operator fixes it. A key that resolves outside the directory (a tampered row; the worker never builds one) is permanent.

**The guarantees, and where they differ from S3.** A final `.xml` name only ever appears complete: the body is written to `<name>.<uuid>.tmp` in the final folder, `fsync`'d, then hard linked to its name with `fs.link`, which fails with `EEXIST` when the name is taken (the create-if-absent; a rename would replace). The sidecar is linked the same way, before the xml, so a document never exists without its sidecar. Temporary names are removed on every exit path; a `.tmp` left behind means the process was killed mid write, and the next put into that folder removes any `.tmp` older than ten minutes. What a filesystem cannot give: there is no directory `fsync` (Windows has none), so a power loss right after the link may lose the name, and the row's next attempt writes it again. A crash between the two links leaves a sidecar without a document: the next attempt of the same event continues from there; a sidecar of *another* event with no document next to it is a foreign claim on the key (only a hand made or tampered sidecar can be one, the key holds the event id): the row is failed with `key_collision` for a manager, who removes the sidecar and retries. A day folder that exists as a plain file is a `config` error, retried until fixed. Five processes putting one key at once end with one file and four `precondition`s, like five conditional puts. The directory must sit on a filesystem with hard links (NTFS, ext4, APFS and the like): on FAT or exFAT, or a mount that refuses `link`, every put fails with an `EPERM` family code and is retried as `config` until the directory is moved.

## Local testing with MinIO or LocalStack

Nothing in `docker-compose.yml` was added; start one by hand next to the database, for example MinIO:

```bash
docker run --rm -p 9000:9000 -p 9001:9001 -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio123 minio/minio server /data --console-address ":9001"
# create the bucket in the console at http://localhost:9001, or: mc alias set local http://localhost:9000 minio minio123 && mc mb local/issuance-exports
```

Then in `server/.env`:

```
XML_EXPORT_ENABLED=true
AWS_REGION=us-east-1
XML_EXPORT_BUCKET=issuance-exports
XML_EXPORT_S3_ENDPOINT=http://localhost:9000
AWS_ACCESS_KEY_ID=minio
AWS_SECRET_ACCESS_KEY=minio123
```

Start the server, assign an issuance on the board, and within five seconds the object appears under `issuance-status-changes/<today>/`. Stop MinIO and assign another: the row goes `pending` with a backoff and a `transient:` error, `GET /api/xml-export` shows `retry_waiting: 1`, and it leaves once MinIO is back. LocalStack works the same with `XML_EXPORT_S3_ENDPOINT=http://localhost:4566` and any access key pair. MinIO answers the conditional put with 412 like AWS does; the `If-None-Match` support of an older LocalStack may be partial, the e2e spec covers that path with a fake instead.

The automated coverage: `server/src/xml-export/*.spec.ts` (the serializer, the builder, the S3 storage against a fake client, the local storage on a temporary directory, the writer and the backoff), `server/src/e2e/xml-export.e2e.spec.ts` (every writing route, the worker against an in-memory bucket: the happy path, the retries, the attempts limit, the corrupt payload, the lost response, the expired lease, the collision, two claims at once, the manager's endpoints) and `server/src/e2e/xml-export-local.e2e.spec.ts` (the application booted with `XML_EXPORT_STORAGE=local` and no AWS variable, the worker on a real directory).

## Deployment

1. Run the migration before the new build starts, as always: `npm run migration:run` or `migration:run:prod` adds `xml_outbox` (`XmlOutbox1791300000000`), see [Schema upgrade](domain.md#schema-upgrade).
2. Start the new build with the worker off. The rows accumulate; nothing else changes for the users.
3. Create the bucket and the role with the policy above, set `AWS_REGION`, `XML_EXPORT_BUCKET` (and the prefix, the KMS key if any), then `XML_EXPORT_ENABLED=true` on one or more processes and restart them. The backlog leaves on the first ticks, oldest first, in order per issuance.
4. Watch `GET /api/xml-export`: `failed` should stay 0; `config` in a log line means the bucket or the policy.

Turning the worker off (`XML_EXPORT_ENABLED` back to unset) stops the uploads and keeps writing the rows; nothing is lost, the backlog waits.
