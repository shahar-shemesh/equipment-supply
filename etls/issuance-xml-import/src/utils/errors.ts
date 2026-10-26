//the two outcomes a file can have besides success. permanent: the bytes will never import (malformed, a contract
//violation, a business refusal), the row is failed / permanent and the file goes to the error directory. retryable:
//the database or the machine failed under the import, the row is failed / retryable, the file stays where it is and
//the run ends; the next tick tries again. anything that is not one of ours is retryable: an unknown failure is more
//often a dependency than the document, and a file refused for good is harder to undo than one tried twice

export class PermanentError extends Error {
  readonly kind = 'permanent';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

export class RetryableError extends Error {
  readonly kind = 'retryable';
  readonly code: string | null;

  constructor(message: string, options?: { cause?: unknown; code?: string | null }) {
    super(message, { cause: options?.cause });
    this.name = 'RetryableError';
    this.code = options?.code ?? null;
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//the claim was taken over while this process still held it: its lease ran out under a long file and another
//instance (or a restart with the same instance id) reclaimed the row. nothing of this process's work may land then,
//the transaction is rolled back and the file is left to the new holder. neither permanent nor retryable: not an
//outcome of the file at all
export class LeaseLostError extends Error {
  readonly kind = 'lease_lost';

  constructor(message: string) {
    super(message);
    this.name = 'LeaseLostError';
  }
}

//a pg unique violation on xml_import_files.document_id: two files with the same DocumentId and other bytes raced
//each other into the commit (the check before the writes catches the sequential case). the second will never apply
export function isDocumentIdViolation(e: unknown) {
  const pg = e as { code?: unknown; detail?: unknown } | null | undefined;
  return pg?.code === '23505' && typeof pg.detail === 'string' && pg.detail.includes('(document_id)');
}

export function classify(e: unknown): PermanentError | RetryableError | LeaseLostError {
  if (e instanceof PermanentError || e instanceof RetryableError || e instanceof LeaseLostError) return e;
  if (isDocumentIdViolation(e)) return new PermanentError('another file with this DocumentId was imported at the same moment', { cause: e });
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return new RetryableError(errorMessage(e), { cause: e, code: typeof code === 'string' ? code : null });
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
