import type { ImportCounts, ImportErrorKind, ImportFileRow } from '../types';
import type { Queryable } from './db';

//xml_import_files (server/src/entities/xml-import-file.entity.ts): the claim, the outcome, the lookups. the claim is
//one statement, so two instances that read the same bytes get exactly one row back between them: the insert takes
//the row for new content, the on-conflict update takes it over for content seen before unless it was completed
//(applied already, whatever the file is called now), someone else holds a live lease on it, or it failed on a
//transient error less than its backoff ago (10 s doubling per attempt, 10 min at most: a file that keeps failing
//is not hammered every tick, and the attempts limit is reached over twenty minutes, not two). the holder of a live
//lease may take its own row back at once: a restarted process with the same ETL_INSTANCE_ID does not wait for a
//lease nobody holds any more (which is why two processes must never share an instance id). no row back means one
//of those, and the caller reads the row to tell which.
//complete and fail are fenced on the instance and the status: a holder whose lease ran out while it worked, and
//whose row another instance took over meanwhile, gets no row back and must not touch the file

export type ClaimInput = { sha256: string; fileName: string; sizeBytes: number; instanceId: string; leaseMs: number };

export const RETRY_BACKOFF_BASE_S = 10;
export const RETRY_BACKOFF_MAX_S = 600;

//what the claim waits for on a failed / retryable row, for the log line of a skipped file
export function retryBackoffMs(attempts: number) {
  return Math.min(RETRY_BACKOFF_MAX_S, RETRY_BACKOFF_BASE_S * 2 ** (Math.max(attempts, 1) - 1)) * 1000;
}

const CLAIM_SQL = `INSERT INTO xml_import_files (content_sha256, file_name, size_bytes, status, instance_id, lease_until, attempts, started_at)
  VALUES ($1, $2, $3, 'processing', $4, now() + $5::int * interval '1 millisecond', 1, now())
  ON CONFLICT (content_sha256) DO UPDATE SET
    status = 'processing', instance_id = EXCLUDED.instance_id, lease_until = EXCLUDED.lease_until, attempts = xml_import_files.attempts + 1,
    file_name = EXCLUDED.file_name, size_bytes = EXCLUDED.size_bytes, started_at = now(), finished_at = NULL, error_kind = NULL
  WHERE xml_import_files.status <> 'completed'
    AND (xml_import_files.lease_until IS NULL OR xml_import_files.lease_until < now() OR xml_import_files.instance_id = EXCLUDED.instance_id)
    AND (xml_import_files.error_kind IS DISTINCT FROM 'retryable' OR xml_import_files.finished_at IS NULL
      OR xml_import_files.finished_at + least(${RETRY_BACKOFF_MAX_S}, ${RETRY_BACKOFF_BASE_S} * power(2, greatest(xml_import_files.attempts, 1) - 1)) * interval '1 second' < now())
  RETURNING *`;

/*──────────────────────────────────────────────────────────────────────────*/

export const importFilesRepository = {
  async claim(db: Queryable, input: ClaimInput): Promise<ImportFileRow | null> {
    const { rows } = await db.query<ImportFileRow>(CLAIM_SQL, [input.sha256, input.fileName, input.sizeBytes, input.instanceId, input.leaseMs]);
    return rows[0] ?? null;
  },

  async findBySha(db: Queryable, sha256: string): Promise<ImportFileRow | null> {
    const { rows } = await db.query<ImportFileRow>('SELECT * FROM xml_import_files WHERE content_sha256 = $1', [sha256]);
    return rows[0] ?? null;
  },

  //the completed row that holds this DocumentId, if any: a document is imported once, from one file
  async findCompletedByDocumentId(db: Queryable, documentId: string): Promise<ImportFileRow | null> {
    const { rows } = await db.query<ImportFileRow>(`SELECT * FROM xml_import_files WHERE document_id = $1 AND status = 'completed'`, [documentId]);
    return rows[0] ?? null;
  },

  //inside the file's transaction, the last statement before COMMIT. false when the row is not this instance's any
  //more (the lease ran out and someone reclaimed it): the caller rolls back
  async complete(db: Queryable, id: string, instanceId: string, result: ImportCounts & { documentId: string }): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE xml_import_files SET status = 'completed', document_id = $3, inserted = $4, updated = $5, unchanged = $6, finished_at = now(), lease_until = NULL, error_kind = NULL, last_error = NULL
       WHERE id = $1 AND instance_id = $2 AND status = 'processing'`,
      [id, instanceId, result.documentId, result.inserted, result.updated, result.unchanged],
    );
    return rowCount === 1;
  },

  //after the rollback, on the pool: its own short statement. the lease is released so the next claim takes the row
  //at once (a retryable one after its backoff); a permanent row is reclaimable too, so the same bytes dropped again
  //after a fix are tried again. false under the same fence as complete: the file is somebody else's then
  async fail(db: Queryable, id: string, instanceId: string, kind: ImportErrorKind, error: string): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE xml_import_files SET status = 'failed', error_kind = $3, last_error = $4, finished_at = now(), lease_until = NULL WHERE id = $1 AND instance_id = $2 AND status = 'processing'`,
      [id, instanceId, kind, error.slice(0, 2000)],
    );
    return rowCount === 1;
  },
};

export type ImportFilesRepository = typeof importFilesRepository;
