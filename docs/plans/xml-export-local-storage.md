---
title: 'Local filesystem storage for the XML export (XML_EXPORT_STORAGE=local)'
type: 'feature'
created: '2026-10-14'
status: 'approved'
base: 'cddac77 plus the uncommitted xml-export-outbox change'
context: ['AGENTS.md', 'server/src/xml-export/s3-storage.service.ts', 'server/src/xml-export/xml-export.worker.ts', 'server/src/xml-export/xml-export.module.ts', 'server/src/env.ts', 'docs/plans/xml-export-outbox.md']
---

## Intent

**Problem:** The XML export only knows S3, so a developer cannot see the documents an issuance change produces without a bucket, and the worker cannot be exercised end to end on a laptop.

**Approach:** One storage interface with the two calls the worker already makes (`putIfAbsent`, `head`), a `LocalXmlStorageService` that writes the same keys under a directory with the same atomicity and reconciliation guarantees the S3 path gives (temporary file, hard link as the create-if-absent, a sidecar with the metadata the head compares), and a module factory that hands the worker the backend `XML_EXPORT_STORAGE` names. Nothing else in the export changes.

## Boundaries & Constraints

**Always:**
- The worker depends on the `XML_STORAGE` token typed as `XmlStorage` (`putIfAbsent(key, body, metadata)`, `head(key)`), never on a concrete class. `S3StorageService` keeps its code and its spec untouched except for `implements XmlStorage`.
- The backend is chosen once at startup from `XML_EXPORT_STORAGE` (`local` | `s3`), default `s3` when unset so every existing `.env` keeps working; any other value refuses startup naming the variable. A failing S3 call never falls back to local, and the other way round.
- `XML_EXPORT_LOCAL_DIR` (default `./exports/xml`) is resolved against the server's working directory to an absolute path. `AWS_REGION` and `XML_EXPORT_BUCKET` are required only for `s3`; `local` needs neither.
- Same key as S3 (`objectKey` untouched): `<dir>/<prefix>YYYY/MM/DD/issuance_<id>_<eventId>.xml`. The resolved file must stay inside the directory; anything else is a `permanent` `StorageError` (the worker fails the row).
- A final `.xml` name only ever appears complete: the body goes to `<name>.<uuid>.tmp` in the same directory, `fsync`, then `fs.link(tmp, final)`; `EEXIST` is the `precondition` category, exactly like a 412. The sidecar `<name>.xml.meta.json` (the metadata object) is linked the same way before the xml. Temporary files are removed on every exit path.
- `head(key)` returns null without the xml; with it, the metadata of the sidecar plus `content-sha256` recomputed from the file's bytes (the sidecar is never trusted for the content). A file without a sidecar reports no `event-id`, so the worker treats it as a collision for a manager.
- Errors map to `StorageError`: `EEXIST` precondition; `EACCES`, `EPERM`, `ENOENT` of the root, `ENOTDIR` transient with `config` true; everything else transient.
- Only the row is marked completed after the link succeeded or the head matched, never on the file name alone.
- Style as the rest of `server/src/xml-export/`: 2 spaces, single quotes, lowercase why comments, the `/*──*/` separator. Specs 4 spaces.

**Never:**
- No change to the outbox, the claim, the fence, the backoff, the builder, the key, the endpoints, the client.
- No new dependency; `node:fs/promises` and `node:crypto` only.
- No `rename` over an existing file, no `writeFile` straight to the final name, no directory `fsync` (Windows has none; documented).
- Generated files never reach git: `server/exports/` in `.gitignore`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First put | key under a missing day folder | folders created, `.xml` and `.xml.meta.json` present, UTF-8 body byte-identical, no `.tmp` left | none |
| Same event again (retry) | file present, same body | `precondition`; `head` gives the sidecar's `event-id` and the file's sha → worker completes, one file | none |
| Another content under the key | file present, different body | `precondition`, file bytes unchanged; head's sha is the stored one | worker: `key_collision` unless the event id matches (then completed with the stored hash, as S3) |
| Five concurrent puts of one key | `Promise.all` | one succeeds, four `precondition`, one file, no `.tmp` | none |
| Crash after the sidecar link, before the xml link | sidecar present with our event id, xml absent | put proceeds to link the xml (the orphan is ours) | none |
| Orphan sidecar of another event | sidecar with a foreign `event-id`, xml absent | `precondition`; head: null (no xml) → worker retries later; documented as a manual clean up | none |
| File copied in by hand, no sidecar | xml present | head: sha only, no `event-id` | worker: `key_collision`, failed for a manager |
| Traversal | prefix or key resolving outside the dir | `StorageError('permanent')` | worker fails the row |
| Root dir unwritable or a file | | `StorageError('transient', config: true)` | retry with backoff, log says `config` |
| `XML_EXPORT_STORAGE=blob` | | startup refused naming the variable | none |
| `local` with no bucket, no region, no credentials | | starts, exports to the directory | none |
| `s3` (or unset) | | the S3 service, exactly as today | none |

## Code Map

- `server/src/xml-export/xml-storage.ts` -- `XmlStorage` interface, `XML_STORAGE` token, `ObjectMetadata` moved here (re-exported from `s3-storage.service.ts` so nothing else moves).
- `server/src/xml-export/local-xml-storage.service.ts` -- the implementation; `resolveKey(dir, key)` exported for its spec.
- `server/src/xml-export/s3-storage.service.ts` -- `implements XmlStorage`, nothing else.
- `server/src/xml-export/xml-export.module.ts` -- `LocalXmlStorageService` provider, `{ provide: XML_STORAGE, useFactory: (s3, local) => xmlExportConfig().storage === 'local' ? local : s3, inject: [S3StorageService, LocalXmlStorageService] }`. The e2e override of `S3StorageService` keeps working through the factory.
- `server/src/xml-export/xml-export.worker.ts` -- `@Inject(XML_STORAGE) private storage: XmlStorage`; the startup log says `local <dir>` or `s3 <bucket>/<prefix>`.
- `server/src/env.ts` -- `storage: 'local' | 's3'`, `localDir: string | null` (absolute when local); bucket/region required only for `s3`; `assertSafeConfig` logs the backend.
- `server/src/env.spec.ts`, `server/src/xml-export/local-xml-storage.service.spec.ts` (temp dir per test via `fs.mkdtemp`, removed in `afterEach`), `server/src/xml-export/xml-export.worker.spec.ts` (the storage stub unchanged, add nothing but the import if needed).
- `server/src/e2e/xml-export-local.e2e.spec.ts` -- boots `AppModule` with `XML_EXPORT_STORAGE=local` and a temp `XML_EXPORT_LOCAL_DIR`, no S3 override, no bucket, no region: assign an issuance, `tick()`, the file exists with the row's `s3_key` as its relative path and the builder's bytes, the row is completed; a second tick writes nothing new.
- `.gitignore`, `server/.env.example`, `docs/xml-export.md` (new section: enabling, where the files are, inspecting, switching, retries, the guarantee differences, "development and testing only"), `README.md` (`## Environment switches` sentence, `## Tests` counts).

## Tasks & Acceptance

**Execution:**
- [x] `server/src/xml-export/xml-storage.ts` -- interface and token -- one contract for both backends.
- [x] `server/src/env.ts`, `env.spec.ts` -- `XML_EXPORT_STORAGE`, `XML_EXPORT_LOCAL_DIR` -- the one reader of the switches (AGENTS.md).
- [x] `server/src/xml-export/local-xml-storage.service.ts` -- temp file, sidecar, link, head, error mapping -- the matrix.
- [x] `server/src/xml-export/xml-export.module.ts`, `xml-export.worker.ts`, `s3-storage.service.ts` -- wiring -- the worker stops naming S3.
- [x] `server/src/xml-export/local-xml-storage.service.spec.ts` -- every matrix row that needs no database, on temp directories.
- [x] `server/src/e2e/xml-export-local.e2e.spec.ts` -- the wiring end to end.
- [x] `.gitignore`, `server/.env.example`, `docs/xml-export.md`, `README.md` -- configuration and documentation, counts from the real runs.

**Acceptance Criteria:**
- Given `XML_EXPORT_STORAGE=local` and no AWS variables, when the server starts and an issuance is assigned, then within one tick `<dir>/issuance-status-changes/<today>/issuance_<id>_<uuid>.xml` exists with the document and the row is `completed` with that relative key in `s3_key`.
- Given the same row is processed again, when the tick ends, then the directory holds one xml and one sidecar for it and the row stays `completed`.
- Given a file with other bytes already under the key, when the worker runs, then the file is unchanged and the row is `failed` with `key_collision` (or completed with the stored hash when the sidecar names the same event).
- Given five concurrent `putIfAbsent` of one key, when all settle, then exactly one resolved, four threw `precondition`, one file exists, no `.tmp` remains.
- Given `XML_EXPORT_STORAGE=s3` or unset, when the existing specs run, then they pass unchanged.
- Given a key that resolves outside the directory, when `putIfAbsent` runs, then it throws `StorageError` with category `permanent` and writes nothing.

## Verification

**Commands:**
- `cd server && npx tsc --noEmit -p tsconfig.json && npm run build` -- expected: clean.
- `cd server && npm run test:unit 2>&1 | tail -40` -- expected: all pass, the new local storage spec included.
- `docker compose up -d && cd server && npm run test:e2e 2>&1 | tail -40` -- expected: all pass, `xml-export-local.e2e.spec.ts` included, `xml-export.e2e.spec.ts` unchanged.
- `cd client && npx tsc --noEmit` -- expected: clean (`shared/@core.ts` is untouched, so no client test run is needed).
- `git status --short server/exports` after the e2e -- expected: nothing (the e2e uses a temp dir; the default dir, if created by a manual run, is ignored).

## Design Notes

```ts
//local-xml-storage.service.ts, the put in short
const file = resolveKey(dir, key);             //throws permanent when outside dir
await mkdir(dirname(file), { recursive: true });
const tmp = `${file}.${randomUUID()}.tmp`, metaTmp = `${file}.meta.${randomUUID()}.tmp`;
try {
  await writeSynced(tmp, body); await writeSynced(metaTmp, JSON.stringify(metadata));
  await linkOrPrecondition(metaTmp, `${file}.meta.json`, { ownOrphanOk: metadata['event-id'] });
  await linkOrPrecondition(tmp, file);
} finally { await rm(tmp, { force: true }); await rm(metaTmp, { force: true }); }
```

`linkOrPrecondition` for the sidecar: on `EEXIST`, read the existing sidecar; if the xml exists, throw precondition (the normal retry); if it does not and the sidecar names our event, continue (our own crashed attempt); otherwise throw precondition (foreign orphan, the head answers null and the row retries; documented).

## Implementation Notes

- 2026-10-14, on top of `cddac77` plus the uncommitted xml-export-outbox change, every task of the plan done. New files: `server/src/xml-export/xml-storage.ts` (`XmlStorage`, `XML_STORAGE`, `ObjectMetadata`), `server/src/xml-export/local-xml-storage.service.ts` (+ `local-xml-storage.service.spec.ts`, 14 tests on `fs.mkdtemp` directories), `server/src/e2e/xml-export-local.e2e.spec.ts` (3 tests). Touched: `s3-storage.service.ts` (`implements XmlStorage`, `ObjectMetadata` re-exported with `export type { } from`), `xml-export.module.ts` (both backends registered, the `XML_STORAGE` factory), `xml-export.worker.ts` (`@Inject(XML_STORAGE) storage: XmlStorage`, the startup line says `storage local <dir>` / `storage s3 <bucket>/<prefix>`), `env.ts` (`storage`, `localDir`, `xmlExportTarget()` for the two log lines, bucket and region required only for `s3`), `env.spec.ts` (one new case, the two `toEqual` objects extended), `.gitignore`, `server/.env.example`, `docs/xml-export.md` (the Storage bullet, the config table, the worker model line, a new `## Local filesystem storage` section, the coverage paragraph), `README.md` (`## Environment switches`, the counts). The worker spec needed nothing, its stub is untyped.
- `fs.link` verified on this NTFS machine before anything was written: a second link of a taken name is `EEXIST`, the linked file survives the removal of its temporary name, `mkdir` under a file is `ENOTDIR`.
- Decision: `StorageError` stays in `s3-storage.service.ts` as the plan's Code Map says ("nothing else moves"); the local service imports it from there. Moving it to `xml-storage.ts` is a two-line follow up if the SDK import ever bothers.
- Decision: the local service takes an optional fixed directory through `@Optional() @Inject(XML_LOCAL_DIR)`, the same shape as `S3_CLIENT`: the unit spec hands it a temp directory and never touches the env; without it the service reads `xmlExportConfig().localDir`, and a call with the `s3` backend configured is a `transient` + `config` error naming `XML_EXPORT_STORAGE` (a wiring mistake, never silent).
- Decision, one row of the matrix tightened: a document already under the key gets no sidecar from a later put. The put checks the name before writing anything, then relies on the link's `EEXIST` for the one that appears in between. Without that check a hand-copied file would have received this event's sidecar and the head would have reported this event id, completing the row over foreign bytes; the matrix wants `key_collision` for a manager there. A document never ends up with a sidecar of an event that did not write it.
- Surprise, Windows: a path under a file answers `ENOENT`, not `ENOTDIR` (Linux gives `ENOTDIR`). The put is unaffected (`mkdir` fails first with `ENOTDIR`), but `head()` had to stat the root before turning `ENOENT` into null: a root that is a file is now `config` on both platforms, the spec covers it with a real file as the root.
- Decision: `resolveKey` refuses an empty key, an absolute key, a NUL byte, and anything whose `path.relative(dir, file)` is empty, `..` or starts with `..` + separator (not `startsWith('..')`, which would refuse a file named `..x.xml`).
- Decision: `XML_EXPORT_STORAGE` is exact and lowercase like `XML_EXPORT_ENABLED=true` (`LOCAL` and `S3` refuse), trimmed, and validated whether or not the worker is on, like the numbers. `XML_EXPORT_LOCAL_DIR` is trimmed and resolved with `path.resolve` against `process.cwd()`; `localDir` is null for `s3`.
- The local e2e spec also deletes `XML_EXPORT_PREFIX` for its process (a developer's `.env` could set one) so the acceptance path `issuance-status-changes/<today>/...` is what it asserts; jest gives every spec file its own copy of `process.env`, the other specs see nothing of it.
- Verified: `npx tsc --noEmit` clean; `npm run build` emits `dist/server/src/xml-export/local-xml-storage.service.js` and `xml-storage.js`; `npm test` in `server/` 245 passed in 26 suites (131 unit, 114 e2e; was 227 / 24, 116 / 111); `xml-export.e2e.spec.ts` unchanged and green through the factory; client `tsc` clean (`shared/@core.ts` untouched, no client test run); `git status --short server/exports` empty after the e2e. README counts updated from that run.
- Not done / risky: no directory `fsync` (documented, Windows has none). A sidecar orphan of another event blocks a key until removed by hand (documented, the matrix accepts it). An unwritable (read-only) root is untested on Windows as the plan allows; `EACCES` / `EPERM` go through `categorizeFs` which the spec exercises with synthetic errors. The `.tmp` names use `wx`, so a uuid collision would surface as `EEXIST` → `precondition` and the row would reconcile against a head that says null → one transient retry; astronomically unlikely, not special cased.

## Plan Change Log

## Review Triage Log

- 2026-10-14, review pass (edge-case-hunter and verification-gap), fixes applied by the caller on top of the implementer's work; the triage below says what and why.

## Plan Change Log

- 2026-10-14, after the review: `StorageError` and its category type moved to `xml-storage.ts` (re-exported from `s3-storage.service.ts`, nothing else imports changed), so the worker and the local backend depend on the contract only. A foreign orphan sidecar (another event's sidecar with no document) is now a `permanent` `key_collision` from the storage, failed for a manager with the reason, instead of a `precondition` whose head answered null and burned the attempts; the matrix row and the doc sentence are updated. `mkdir` failures map to transient `config` (a day folder that is a plain file said `EEXIST`, which read as a taken key). A put sweeps `.tmp` names older than ten minutes in its folder. `setup-env.ts` blanks `XML_EXPORT_STORAGE` and `XML_EXPORT_LOCAL_DIR` so a developer's `.env` set to `local` cannot turn the S3 e2e into a file-writing run; the local e2e sets its own values after that import. Must survive: the sidecar before the xml, the link as the create-if-absent, no rename over a final name.

## Review Triage Log

2026-10-14, two reviewers on `build-xml-export-local-storage.diff`.

Edge-case hunter, 6 findings:
- fixed: `mkdir` under a plain file surfaced as `EEXIST` → `precondition` → head null → retries to the limit; now transient `config` with the folder named, unit test added.
- fixed: a foreign orphan sidecar retried until the limit as "412 but no object", the reason lost; now `permanent` `key_collision` from the storage, unit test updated, doc updated.
- fixed: `head()` let a raw `stat` error of the root escape (worker logged it as unexpected, no `config` flag); mapped through `categorizeFs`.
- fixed: a process killed between the temporary write and the `finally` left `.tmp` files forever; a put now removes `.tmp` names older than ten minutes in its folder (unit test: the stale one goes, the fresh one stays), doc updated.
- fixed: a developer's `.env` with `XML_EXPORT_STORAGE=local` reached the S3 e2e through dotenv and defeated the `S3StorageService` override; `setup-env.ts` blanks it, the S3 spec asserts it holds the fake.
- fixed (claim): the worker still imported `StorageError` from the S3 file; moved to `xml-storage.ts`.

Verification gap, 2 findings plus notes:
- fixed: no test failed a put after the body was on disk. The spec wraps `fs.link` (the one mock in that file) and one test fails the final link with `EIO` after checking that the final name did not exist and the temporary held every byte; afterwards no document, no `.tmp`, only the event's own sidecar, head null, category transient, and the next put completes from the orphan. The reviewer's suggested "write to the final name with `wx`" regression now fails that test.
- fixed: the S3 e2e backed "unchanged" only while the machine's env left the backend unset (the reviewer demonstrated 6 failures and real files under `server/exports` with `XML_EXPORT_STORAGE=local` in the shell); `setup-env.ts` and the assertion above. The files that demonstration left under `server/exports` were removed.
- fixed (notes): the doc said a missing directory is `config` and retried, while a put creates it (reworded, in the service comment too); "like a missing bucket" dropped (S3's head turns a 404 into null, the two paths differ); the hard link requirement of the directory's filesystem is now stated in the doc.
- refuted: none.

