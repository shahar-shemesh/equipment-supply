import { describe, expect, it } from 'vitest';

import { LeaseLostError, PermanentError, RetryableError, classify, errorMessage } from './errors';

//what classify makes of what the pipeline catches: ours pass through, the document id race is permanent, everything
//else is retryable with its code kept for the log line

describe('classify', () => {
  it('passes the three kinds of ours through untouched', () => {
    const permanent = new PermanentError('bad');
    const retryable = new RetryableError('later', { code: 'ECONNRESET' });
    const lost = new LeaseLostError('taken');
    expect(classify(permanent)).toBe(permanent);
    expect(classify(retryable)).toBe(retryable);
    expect(classify(lost)).toBe(lost);
  });

  it('turns a unique violation on document_id into a permanent refusal and keeps the cause', () => {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', detail: 'Key (document_id)=(SAP-DLV-1) already exists.' });
    const result = classify(cause);
    expect(result).toBeInstanceOf(PermanentError);
    expect(result.message).toBe('another file with this DocumentId was imported at the same moment');
    expect(result.cause).toBe(cause);
  });

  it('keeps every other unique violation and every foreign error retryable, with the code when there is one', () => {
    const sap = classify(Object.assign(new Error('duplicate key'), { code: '23505', detail: 'Key (sap_number)=(1) already exists.' }));
    expect(sap).toBeInstanceOf(RetryableError);
    expect((sap as RetryableError).code).toBe('23505');
    const gone = classify(Object.assign(new Error('connection terminated'), { code: '08006' }));
    expect(gone).toBeInstanceOf(RetryableError);
    expect((gone as RetryableError).code).toBe('08006');
    const plain = classify(new TypeError('x is not a function'));
    expect(plain).toBeInstanceOf(RetryableError);
    expect((plain as RetryableError).code).toBeNull();
    expect(plain.message).toBe('x is not a function');
    const thrownString = classify('boom');
    expect(thrownString).toBeInstanceOf(RetryableError);
    expect(thrownString.message).toBe('boom');
  });

  it('reads a message off anything', () => {
    expect(errorMessage(new Error(''))).toBe('Error');
    expect(errorMessage(42)).toBe('42');
  });
});
