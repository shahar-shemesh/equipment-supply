import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { IssuanceStatus } from '../../../../shared/@core';
import { editableStatuses } from '../../../../shared/@rules';
import type { Config } from '../config/env';
import { parseDocument } from '../parsers/xml-parser';
import type { Queryable, Transaction } from '../repositories/db';
import { ImportFilesRepository, retryBackoffMs } from '../repositories/import-files.repository';
import type { IssuancesRepository } from '../repositories/issuances.repository';
import type { FileOutcome, ImportCounts, ImportFileRow, ParsedDocument, RunSummary, RunTrigger } from '../types';
import { LeaseLostError, PermanentError, RetryableError, classify } from '../utils/errors';
import { Logger, shortSha } from '../utils/logger';
import { moveSafely, writeSidecar } from './files';
import { Candidate, scan } from './scanner';
import { diffIssuance, insertColumns } from './transform';

//one run: scan, then per file fingerprint, claim, parse, import in one transaction, archive. the order of the checks
//is the order of the cost: the size from stat before the read, the sha256 before the parse, the claim before the
//parse (a file seen before is answered by its row, its bytes are never parsed twice), the parse before the
//transaction (a contract violation never opens one). a retryable failure ends the run: the database is the one
//dependency every file shares, and the next tick is the retry

export type PipelineConfig = Pick<Config, 'dirs' | 'batchSize' | 'minFileAgeMs' | 'maxFileBytes' | 'leaseMs' | 'maxAttempts' | 'instanceId'>;

export type PipelineDeps = {
  config: PipelineConfig;
  db: Queryable; //the pool: the claim, the lookups and the failure marks run outside the file's transaction
  transaction: Transaction;
  importFiles: ImportFilesRepository;
  issuances: IssuancesRepository;
  logger: Logger;
  parse?: (bytes: Buffer) => ParsedDocument;
  now?: () => Date;
};

type Abort = { abort: string };

const INT4_MAX = 2147483647;

/*──────────────────────────────────────────────────────────────────────────*/

export async function runOnce(deps: PipelineDeps, runId: string, trigger: RunTrigger): Promise<RunSummary> {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger.child({ run_id: runId, instance_id: deps.config.instanceId });
  const summary: RunSummary = { id: runId, trigger, started_at: now().toISOString(), finished_at: null, discovered: 0, processed: 0, succeeded: 0, failed: 0, skipped: 0, already_imported: 0, error: null };
  log.info('run started', { trigger });

  let scanned: Awaited<ReturnType<typeof scan>> | null = null;
  try {
    scanned = await scan({ dir: deps.config.dirs.input, minAgeMs: deps.config.minFileAgeMs, batchSize: deps.config.batchSize, now: () => now().getTime() });
  } catch (e) {
    summary.error = `scan failed: ${(e as Error).message}`;
    log.error('scan failed', { error: (e as Error).message });
  }

  if (scanned) {
    if (scanned.missingDir) log.warn('input directory is missing, nothing to do', { dir: deps.config.dirs.input });
    for (const u of scanned.unreadable) log.warn('file could not be read by the scan, skipped', { file: u.name, code: u.code });
    summary.discovered = scanned.files.length;
    for (const file of scanned.files) {
      const outcome = await processFile(deps, log.child({ file: file.name }), file);
      if (typeof outcome !== 'string') {
        summary.error = outcome.abort;
        break;
      }
      if (outcome !== 'skipped') summary.processed++;
      summary[outcome]++;
    }
  }

  summary.finished_at = now().toISOString();
  log.info('run finished', { trigger, discovered: summary.discovered, processed: summary.processed, succeeded: summary.succeeded, failed: summary.failed, skipped: summary.skipped, already_imported: summary.already_imported, error: summary.error });
  return summary;
}

/*──────────────────────────────────────────────────────────────────────────*/

async function processFile(deps: PipelineDeps, log: Logger, file: Candidate): Promise<FileOutcome | Abort> {
  const cfg = deps.config;

  //the size again, right before the read: a file still growing under a slow writer is left for the next run
  let size: number;
  try {
    size = (await fs.stat(file.path)).size;
  } catch {
    log.info('file is gone, skipped');
    return 'skipped';
  }
  if (size !== file.size) {
    log.info('file changed under the scan, skipped');
    return 'skipped';
  }
  if (size > cfg.maxFileBytes) return refuseOversized(deps, log, file, size);

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file.path);
  } catch (e) {
    log.warn('file could not be read, skipped', { error: (e as Error).message });
    return 'skipped';
  }
  if (bytes.length !== size) {
    log.info('file changed under the read, skipped');
    return 'skipped';
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const flog = log.child({ sha256: shortSha(sha256) });

  let row: ImportFileRow | null;
  try {
    row = await deps.importFiles.claim(deps.db, { sha256, fileName: file.name, sizeBytes: size, instanceId: cfg.instanceId, leaseMs: cfg.leaseMs });
    if (!row) {
      const existing = await deps.importFiles.findBySha(deps.db, sha256);
      if (existing?.status === 'completed') {
        flog.info('already imported, archived without a second import', { document_id: existing.document_id, imported_as: existing.file_name });
        await archive(deps, flog, file);
        return 'already_imported';
      }
      if (existing?.status === 'failed' && existing.error_kind === 'retryable') {
        flog.info('failed on a transient error recently, left for its retry backoff', { attempts: existing.attempts, backoff_ms: retryBackoffMs(existing.attempts), last_error: existing.last_error });
      } else {
        flog.info('claimed by another instance, skipped', { holder: existing?.instance_id ?? null });
      }
      return 'skipped';
    }
  } catch (e) {
    const err = classify(e);
    flog.error('claim failed, the run ends', { error: err.message, code: err instanceof RetryableError ? err.code : null });
    return { abort: `${file.name}: claim failed: ${err.message}` };
  }

  const alog = flog.child({ attempt: row.attempts });
  try {
    const doc = (deps.parse ?? parseDocument)(bytes);
    const dlog = alog.child({ document_id: doc.document_id });
    const counts = await deps.transaction(async (client) => {
      const other = await deps.importFiles.findCompletedByDocumentId(client, doc.document_id);
      if (other && other.id !== row.id) throw new PermanentError(`document ${doc.document_id} was imported from file ${other.file_name} already`);
      const counts = await importDocument(client, deps, doc, row, file.name, dlog);
      //the fence: a lease that ran out under a long file and a row somebody reclaimed meanwhile. the rollback below
      //discards the work, the new holder's import stands, the file is theirs to archive
      if (!(await deps.importFiles.complete(client, row.id, cfg.instanceId, { documentId: doc.document_id, ...counts }))) throw new LeaseLostError('the lease ran out and the row was reclaimed, the import is rolled back');
      return counts;
    });
    dlog.info('file imported', { ...counts });
    await archive(deps, dlog, file);
    return 'succeeded';
  } catch (e) {
    const err = classify(e);
    if (err instanceof LeaseLostError) {
      alog.warn('lease lost, the file is left to its new holder', { error: err.message, lease_ms: cfg.leaseMs });
      return 'skipped';
    }
    return handleFailure(deps, alog, file, sha256, row, err);
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//inside the file's transaction: every issuance of the document in order, each one locked before it is read. an
//insert for an unknown sap number, nothing for an identical one, an update where something differs, and a refusal
//of the whole file where the differing issuance is in a status the document may not change (delivered, partially
//delivered, deleted: the closed rows of shared/@rules.ts)
async function importDocument(client: Queryable, deps: PipelineDeps, doc: ParsedDocument, fileRow: ImportFileRow, fileName: string, log: Logger): Promise<ImportCounts> {
  const counts: ImportCounts = { inserted: 0, updated: 0, unchanged: 0 };
  //the rows of the whole file first, in id order, the order the server's bulk actions (assign, mark urgent) take
  //theirs in: a file whose issuances sit in the opposite order to a concurrent bulk action would otherwise deadlock
  //with it, and postgres may pick the manager's request as the victim
  await deps.issuances.lockAllBySapNumbers(client, doc.issuances.map((i) => i.sap_number));
  for (const parsed of doc.issuances) {
    const ilog = log.child({ sap_number: parsed.sap_number });
    const row = await deps.issuances.lockBySapNumber(client, parsed.sap_number);
    if (!row) {
      const { issuance, items } = insertColumns(parsed);
      const id = await deps.issuances.insert(client, parsed.sap_number, issuance, items);
      await deps.issuances.audit(client, { issuance_id: id, batch_id: fileRow.id, details: { sap_number: parsed.sap_number, mode: 'insert', changed: [], file: fileName, document_id: doc.document_id } });
      counts.inserted++;
      ilog.info('issuance inserted', { issuance_id: id, items: items.length });
      continue;
    }

    const diff = diffIssuance(parsed, row);
    if (!diff.changed.length) {
      counts.unchanged++;
      ilog.debug('issuance unchanged', { issuance_id: row.id });
      continue;
    }
    if (!editableStatuses.includes(row.status)) throw new PermanentError(`issuance ${parsed.sap_number} is ${row.status}, the document cannot change it`);
    //a line added or brought back while a courier holds the issuance would make the courier's stale offline report
    //fail the server's one-answer-per-line check as a 400 (the tablet files that as invalid, with no evidence path)
    //instead of reaching the lock for its 409 revision_changed: the server only knows how to forgive a line that was
    //taken off (docs/offline-sync.md). field changes and removals take that designed path; an added line waits until
    //the issuance leaves the courier's hands. open decision 17
    if (row.status === IssuanceStatus.assigned) {
      const added = [...diff.items.inserts.map((i) => i.line_no), ...diff.items.updates.filter((u) => u.restore).map((u) => u.line_no)].sort((a, b) => a - b);
      if (added.length) throw new PermanentError(`issuance ${parsed.sap_number} is assigned, the document adds line ${added.join(', ')} while a courier holds it`);
    }

    await deps.issuances.update(client, row.id, diff.patch, diff.bumpsRevision);
    await deps.issuances.applyItems(client, row.id, diff.items);
    await deps.issuances.audit(client, { issuance_id: row.id, batch_id: fileRow.id, details: { sap_number: parsed.sap_number, mode: 'update', changed: diff.changed, file: fileName, document_id: doc.document_id, revision_bumped: diff.bumpsRevision } });
    counts.updated++;
    ilog.info('issuance updated', { issuance_id: row.id, changed: diff.changed, revision_bumped: diff.bumpsRevision });
  }
  return counts;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the row is marked outside the rolled back transaction, in its own statement. a permanent failure moves the file
//and writes the sidecar; a retryable one leaves the file and ends the run. a retryable failure past the attempts
//limit is permanent: the file was tried enough. when the database cannot even take the mark, the file stays
//whatever the kind, so nothing is moved on a word nobody recorded
async function handleFailure(deps: PipelineDeps, log: Logger, file: Candidate, sha256: string, row: ImportFileRow, err: PermanentError | RetryableError): Promise<FileOutcome | Abort> {
  let permanent = err instanceof PermanentError;
  let message = err.message;
  if (!permanent && row.attempts >= deps.config.maxAttempts) {
    permanent = true;
    message = `attempts exhausted (${row.attempts}): ${message}`;
  }

  if (permanent) {
    let recorded: boolean;
    try {
      recorded = await deps.importFiles.fail(deps.db, row.id, deps.config.instanceId, 'permanent', message);
    } catch (e) {
      log.error('the refusal could not be recorded, the file stays and the run ends', { error: (e as Error).message, refusal: message });
      return { abort: `${file.name}: ${(e as Error).message}` };
    }
    if (!recorded) {
      log.warn('the row was reclaimed meanwhile, the refusal is not recorded and the file is left to its new holder', { refusal: message });
      return 'skipped';
    }
    log.warn('file refused', { error: message });
    await toErrorDir(deps, log, file, sha256, message);
    return 'failed';
  }

  try {
    if (!(await deps.importFiles.fail(deps.db, row.id, deps.config.instanceId, 'retryable', message))) log.warn('the row was reclaimed meanwhile, the failure is not recorded');
  } catch (e) {
    log.warn('the failure could not be recorded either', { error: (e as Error).message });
  }
  log.error('file failed on a transient error, it stays for the next run and the run ends', { error: message, code: err instanceof RetryableError ? err.code : null });
  return { abort: `${file.name}: ${message}` };
}

//a file larger than the limit is never read, so its row is keyed by a stand-in fingerprint of its name and size
//(documented in the README): the same oversized file dropped again lands on the same row
async function refuseOversized(deps: PipelineDeps, log: Logger, file: Candidate, size: number): Promise<FileOutcome | Abort> {
  const sha256 = createHash('sha256').update(`oversized\0${file.name}\0${size}`).digest('hex');
  let row: ImportFileRow | null;
  try {
    row = await deps.importFiles.claim(deps.db, { sha256, fileName: file.name, sizeBytes: Math.min(size, INT4_MAX), instanceId: deps.config.instanceId, leaseMs: deps.config.leaseMs });
  } catch (e) {
    const err = classify(e);
    log.error('claim failed, the run ends', { error: err.message });
    return { abort: `${file.name}: claim failed: ${err.message}` };
  }
  if (!row) {
    log.info('oversized file is claimed by another instance, skipped');
    return 'skipped';
  }
  return handleFailure(deps, log.child({ sha256: shortSha(sha256) }), file, sha256, row, new PermanentError(`the file is ${size} bytes, the limit is ${deps.config.maxFileBytes}`));
}

/*──────────────────────────────────────────────────────────────────────────*/

//after the commit. a failure here is a log line: the file stays in the input directory, the next run finds its row
//completed and archives it without touching the database
async function archive(deps: PipelineDeps, log: Logger, file: Candidate) {
  try {
    const dest = await moveSafely(file.path, deps.config.dirs.archive, file.name);
    log.info('file archived', { archived_as: path.basename(dest) });
  } catch (e) {
    log.error('archive failed, the file stays in the input directory', { error: (e as Error).message });
  }
}

async function toErrorDir(deps: PipelineDeps, log: Logger, file: Candidate, sha256: string, error: string) {
  const now = deps.now ?? (() => new Date());
  let finalName: string;
  try {
    finalName = path.basename(await moveSafely(file.path, deps.config.dirs.error, file.name));
  } catch (e) {
    log.error('the move to the error directory failed, the file stays', { error: (e as Error).message });
    return;
  }
  //the move stands on its own: a sidecar that cannot be written is a log line with the final name, and the row's
  //last_error holds the same text
  try {
    await writeSidecar(deps.config.dirs.error, finalName, { file: file.name, sha256, error, at: now().toISOString() });
    log.info('file moved to the error directory', { error_file: finalName });
  } catch (e) {
    log.error('file moved to the error directory, its sidecar could not be written', { error_file: finalName, error: (e as Error).message });
  }
}
