import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IssuanceStatus, Priority } from '../../../../shared/@core';
import type { ImportFilesRepository } from '../repositories/import-files.repository';
import type { IssuancesRepository } from '../repositories/issuances.repository';
import type { ImportFileRow, LoadedIssuance } from '../types';
import { createLogger } from '../utils/logger';
import { PipelineDeps, runOnce } from './pipeline';

//the pipeline on fake repositories and real temporary directories: the lifecycle of a file per outcome, without a
//database. what the sql does is the e2e suite's business

const FIXTURES = path.join(__dirname, '..', 'parsers', 'fixtures');
const VALID = path.join(FIXTURES, 'valid-two-issuances.xml');

let root: string;
let deps: PipelineDeps;
let calls: string[];
let lines: string[];
let rows: Map<string, ImportFileRow>;
let loaded: Map<string, LoadedIssuance>;
let claimAnswer: ((sha: string) => ImportFileRow | null) | null;
let lockError: Error | null;
let failError: Error | null;
let completeError: Error | null;
let rowTaken: boolean; //the fence: complete and fail find the row reclaimed

function row(sha: string, overrides: Partial<ImportFileRow> = {}): ImportFileRow {
  return { id: `row-${sha.slice(0, 6)}`, content_sha256: sha, document_id: null, file_name: 'f', size_bytes: 1, status: 'processing', error_kind: null, attempts: 1, instance_id: 'etl-a', lease_until: null, started_at: new Date(), finished_at: null, inserted: 0, updated: 0, unchanged: 0, last_error: null, created_at: new Date(), ...overrides };
}

const importFiles: ImportFilesRepository = {
  async claim(_db, input) {
    calls.push(`claim ${input.fileName}`);
    if (claimAnswer) return claimAnswer(input.sha256);
    const existing = rows.get(input.sha256);
    if (existing && (existing.status === 'completed' || (existing.lease_until && existing.lease_until > new Date()))) return null;
    const next = row(input.sha256, { file_name: input.fileName, size_bytes: input.sizeBytes, attempts: (existing?.attempts ?? 0) + 1, lease_until: new Date(Date.now() + input.leaseMs) });
    rows.set(input.sha256, next);
    return next;
  },
  async findBySha(_db, sha) {
    return rows.get(sha) ?? null;
  },
  async findCompletedByDocumentId(_db, documentId) {
    return [...rows.values()].find((r) => r.status === 'completed' && r.document_id === documentId) ?? null;
  },
  async complete(_db, id, instanceId, result) {
    if (completeError) throw completeError;
    calls.push(`complete ${id} ${result.documentId} ${result.inserted}/${result.updated}/${result.unchanged}`);
    const r = [...rows.values()].find((x) => x.id === id)!;
    if (rowTaken || r.instance_id !== instanceId) return false;
    Object.assign(r, { status: 'completed', document_id: result.documentId, lease_until: null, ...result });
    return true;
  },
  async fail(_db, id, instanceId, kind, error) {
    if (failError) throw failError;
    const r = [...rows.values()].find((x) => x.id === id)!;
    if (rowTaken || r.instance_id !== instanceId) return false;
    calls.push(`fail ${id} ${kind}: ${error}`);
    Object.assign(r, { status: 'failed', error_kind: kind, last_error: error, lease_until: null });
    return true;
  },
};

const issuances: IssuancesRepository = {
  async lockAllBySapNumbers(_c, saps) {
    calls.push(`lockall ${saps.join(',')}`);
  },
  async lockBySapNumber(_c, sap) {
    if (lockError) throw lockError;
    calls.push(`lock ${sap}`);
    return loaded.get(sap) ?? null;
  },
  async insert(_c, sap, _cols, items) {
    calls.push(`insert ${sap} items ${items.length}`);
    return 100 + loaded.size;
  },
  async update(_c, id, patch, bump) {
    calls.push(`update ${id} ${Object.keys(patch).join(',')} bump=${bump}`);
  },
  async applyItems(_c, id, plan) {
    calls.push(`items ${id} +${plan.inserts.length} ~${plan.updates.length} -${plan.removes.length}`);
  },
  async audit(_c, input) {
    calls.push(`audit ${input.issuance_id} ${input.details.mode} [${input.details.changed.join(',')}]`);
  },
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'etl-pipe-'));
  for (const d of ['input', 'archive', 'error']) await fs.mkdir(path.join(root, d));
  calls = [];
  lines = [];
  rows = new Map();
  loaded = new Map();
  claimAnswer = null;
  lockError = null;
  failError = null;
  completeError = null;
  rowTaken = false;
  deps = {
    config: { dirs: { input: path.join(root, 'input'), archive: path.join(root, 'archive'), error: path.join(root, 'error') }, batchSize: 100, minFileAgeMs: 0, maxFileBytes: 5000, leaseMs: 60000, maxAttempts: 3, instanceId: 'etl-a' },
    db: { query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }) },
    transaction: (fn) => fn({} as any),
    importFiles,
    issuances,
    logger: createLogger('debug', {}, (line) => lines.push(line)),
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function drop(name: string, from = VALID) {
  await fs.copyFile(from, path.join(root, 'input', name));
  return createHash('sha256').update(await fs.readFile(from)).digest('hex');
}

const listing = (dir: string) => fs.readdir(path.join(root, dir)).then((n) => n.sort());

describe('runOnce', () => {
  it('imports a valid file: claim, lock per issuance, insert, audit, complete, archive', async () => {
    const sha = await drop('a.xml');
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ id: 'run-1', trigger: 'auto', discovered: 1, processed: 1, succeeded: 1, failed: 0, skipped: 0, already_imported: 0, error: null });
    expect(calls).toEqual(['claim a.xml', 'lockall 2000592,0002000593', 'lock 2000592', 'insert 2000592 items 2', 'audit 100 insert []', 'lock 0002000593', 'insert 0002000593 items 1', 'audit 100 insert []', `complete row-${sha.slice(0, 6)} SAP-DLV-2026-000123 2/0/0`]);
    expect(await listing('input')).toEqual([]);
    expect(await listing('archive')).toEqual(['a.xml']);
    expect(lines.some((l) => l.includes('"msg":"file imported"') && l.includes('"document_id":"SAP-DLV-2026-000123"') && l.includes('"run_id":"run-1"'))).toBe(true);
    expect(lines.join('\n')).not.toContain('ישראל');
  });

  it('archives a file whose row is completed under a free name without touching the database', async () => {
    await drop('a.xml');
    await runOnce(deps, 'run-1', 'auto');
    calls.length = 0;
    await drop('a.xml');
    await drop('copy.xml');
    const summary = await runOnce(deps, 'run-2', 'manual');
    expect(summary).toMatchObject({ discovered: 2, processed: 2, already_imported: 2, succeeded: 0 });
    expect(calls).toEqual(['claim a.xml', 'claim copy.xml']);
    expect(await listing('archive')).toEqual(['a.1.xml', 'a.xml', 'copy.xml']);
    expect(lines.filter((l) => l.includes('already imported'))).toHaveLength(2);
  });

  it('skips a file another instance holds, a young file and a file that moved under the scan', async () => {
    const sha = await drop('held.xml');
    rows.set(sha, row(sha, { lease_until: new Date(Date.now() + 60000), instance_id: 'etl-b' }));
    deps.config.minFileAgeMs = 60000;
    await drop('young.xml', path.join(FIXTURES, 'status-element.xml'));
    //windows copyFile keeps the source's mtime: the ages are set by hand
    const old = new Date(Date.now() - 120000);
    await fs.utimes(path.join(root, 'input', 'held.xml'), old, old);
    await fs.utimes(path.join(root, 'input', 'young.xml'), new Date(), new Date());
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ discovered: 1, processed: 0, skipped: 1 });
    expect(await listing('input')).toEqual(['held.xml', 'young.xml']);
    expect(lines.some((l) => l.includes('claimed by another instance') && l.includes('"holder":"etl-b"'))).toBe(true);
  });

  it('refuses a contract violation: nothing imported, the row failed permanent, the file and its sidecar in the error directory', async () => {
    const sha = await drop('bad.xml', path.join(FIXTURES, 'invalid-second-issuance.xml'));
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ discovered: 1, processed: 1, failed: 1, succeeded: 0, error: null });
    expect(calls).toEqual(['claim bad.xml', `fail row-${sha.slice(0, 6)} permanent: Issuances/Issuance[2]/Priority must be normal or urgent`]);
    expect(await listing('error')).toEqual(['bad.xml', 'bad.xml.error.json']);
    const sidecar = JSON.parse(await fs.readFile(path.join(root, 'error', 'bad.xml.error.json'), 'utf8'));
    expect(sidecar).toMatchObject({ file: 'bad.xml', sha256: sha, error: 'Issuances/Issuance[2]/Priority must be normal or urgent' });
    expect(Date.parse(sidecar.at)).not.toBeNaN();
  });

  it('refuses the file when a delivered issuance differs, after the transaction rolled back', async () => {
    loaded.set('2000592', { id: 5, sap_number: '2000592', status: IssuanceStatus.delivered, revision: 2, number_prefix: null, priority: Priority.normal, delivery_date: null, customer_name: 'other', customer_id_number: null, customer_phone: null, address_street: 's', address_building: null, address_city: 'c', notes: null, items: [] });
    await drop('a.xml');
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ failed: 1 });
    expect(calls.at(-1)).toMatch(/^fail row-\w+ permanent: issuance 2000592 is delivered, the document cannot change it$/);
    expect(calls).not.toContain('update 5');
    expect(await listing('error')).toEqual(['a.xml', 'a.xml.error.json']);
  });

  it('updates an unassigned issuance that differs and counts an identical one as unchanged', async () => {
    const base: LoadedIssuance = { id: 5, sap_number: '2000592', status: IssuanceStatus.unassigned, revision: 1, number_prefix: "ד'", priority: Priority.normal, delivery_date: '2026-10-30', customer_name: 'ישראל ישראלי', customer_id_number: '012345678', customer_phone: '050-0000000', address_street: 'הרצל 12', address_building: 'בניין B קומה 3', address_city: 'תל אביב', notes: 'להתקשר לפני ההגעה & לעלות עם המעלית', items: [{ id: 1, line_no: 1, product_name: 'מחשב IEXXX', catalog_number: 'PKG-1102', station_number: '1104', serial_number: 'SN1', quantity: 1, removed: false }, { id: 2, line_no: 2, product_name: 'מסך 24"', catalog_number: 'PKG-2201', station_number: null, serial_number: null, quantity: 2, removed: false }] };
    loaded.set('2000592', base);
    loaded.set('0002000593', { id: 6, sap_number: '0002000593', status: IssuanceStatus.assigned, revision: 1, number_prefix: null, priority: Priority.urgent, delivery_date: null, customer_name: 'שרה כהן', customer_id_number: null, customer_phone: null, address_street: 'בן גוריון 5', address_building: null, address_city: 'חיפה', notes: '<דחוף> לפני 10:00', items: [{ id: 3, line_no: 1, product_name: 'מדפסת', catalog_number: null, station_number: null, serial_number: null, quantity: 1, removed: false }] });
    await drop('a.xml');
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ succeeded: 1 });
    expect(calls).toContain('update 5 customer_phone bump=true');
    expect(calls).toContain('items 5 +0 ~0 -0');
    expect(calls).toContain('audit 5 update [customer_phone]');
    expect(calls.find((c) => c.startsWith('complete'))).toMatch(/ 0\/1\/1$/);
  });

  it('refuses a line added to an assigned issuance, a courier holds it', async () => {
    loaded.set('2000592', { id: 5, sap_number: '2000592', status: IssuanceStatus.assigned, revision: 3, number_prefix: "ד'", priority: Priority.normal, delivery_date: '2026-10-30', customer_name: 'ישראל ישראלי', customer_id_number: '012345678', customer_phone: '050-1234567', address_street: 'הרצל 12', address_building: 'בניין B קומה 3', address_city: 'תל אביב', notes: 'להתקשר לפני ההגעה & לעלות עם המעלית', items: [{ id: 1, line_no: 1, product_name: 'מחשב IEXXX', catalog_number: 'PKG-1102', station_number: '1104', serial_number: 'SN1', quantity: 1, removed: false }] });
    await drop('a.xml');
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ failed: 1, succeeded: 0 });
    expect(calls.at(-1)).toMatch(/^fail row-\w+ permanent: issuance 2000592 is assigned, the document adds line 2 while a courier holds it$/);
    expect(calls).not.toContain('update 5');
    expect(await listing('error')).toEqual(['a.xml', 'a.xml.error.json']);
  });

  it('refuses a second file under a DocumentId that another file completed', async () => {
    const sha = await drop('first.xml');
    await runOnce(deps, 'run-1', 'auto');
    const bytes = (await fs.readFile(VALID, 'utf8')).replace('<Priority>normal</Priority>', '<Priority>urgent</Priority>');
    await fs.writeFile(path.join(root, 'input', 'second.xml'), bytes);
    const summary = await runOnce(deps, 'run-2', 'auto');
    expect(summary).toMatchObject({ failed: 1 });
    expect(calls.at(-1)).toContain(`permanent: document SAP-DLV-2026-000123 was imported from file first.xml already`);
    expect(rows.get(sha)!.status).toBe('completed');
    expect(await listing('error')).toEqual(['second.xml', 'second.xml.error.json']);
  });

  it('ends the run on a transient failure: the row failed retryable, the file stays, the next file waits', async () => {
    await drop('a.xml');
    await drop('b.xml', path.join(FIXTURES, 'status-element.xml'));
    lockError = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ discovered: 2, processed: 0, succeeded: 0, failed: 0, error: 'a.xml: terminating connection due to administrator command' });
    expect(calls).toEqual(['claim a.xml', 'lockall 2000592,0002000593', expect.stringMatching(/^fail row-\w+ retryable: terminating connection/)]);
    expect(await listing('input')).toEqual(['a.xml', 'b.xml']);
    expect(await listing('error')).toEqual([]);
    expect(lines.some((l) => l.includes('"code":"57P01"'))).toBe(true);
  });

  it('turns a transient failure past the attempts limit into a permanent one', async () => {
    const sha = await drop('a.xml');
    rows.set(sha, row(sha, { status: 'failed', error_kind: 'retryable', attempts: 2 }));
    lockError = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ failed: 1, error: null });
    expect(calls.at(-1)).toBe(`fail row-${sha.slice(0, 6)} permanent: attempts exhausted (3): connection refused`);
    expect(await listing('error')).toEqual(['a.xml', 'a.xml.error.json']);
  });

  it('refuses an oversized file without reading it, under a stand-in fingerprint', async () => {
    deps.parse = () => {
      throw new Error('must not be read');
    };
    await fs.writeFile(path.join(root, 'input', 'big.xml'), 'x'.repeat(6000));
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ failed: 1 });
    const key = createHash('sha256').update('oversized\0big.xml\x006000').digest('hex');
    expect(rows.get(key)).toMatchObject({ status: 'failed', error_kind: 'permanent', last_error: 'the file is 6000 bytes, the limit is 5000', size_bytes: 6000 });
    expect(await listing('error')).toEqual(['big.xml', 'big.xml.error.json']);
  });

  it('ends the run when the claim itself fails and leaves the file alone', async () => {
    await drop('a.xml');
    claimAnswer = () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary.error).toBe('a.xml: claim failed: connect ECONNREFUSED');
    expect(await listing('input')).toEqual(['a.xml']);
    expect(calls).toEqual(['claim a.xml']);
  });

  it('keeps a refused file in place when the refusal cannot be recorded', async () => {
    await drop('bad.xml', path.join(FIXTURES, 'malformed.xml'));
    failError = Object.assign(new Error('gone'), { code: '08006' });
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ failed: 0, error: 'bad.xml: gone' });
    expect(await listing('input')).toEqual(['bad.xml']);
    expect(await listing('error')).toEqual([]);
  });

  it('rolls the import back and leaves the file alone when the row was reclaimed under it', async () => {
    rowTaken = true;
    await drop('a.xml');
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ discovered: 1, processed: 0, skipped: 1, succeeded: 0, failed: 0, error: null });
    expect(calls.some((c) => c.startsWith('complete'))).toBe(true);
    expect(calls.some((c) => c.startsWith('fail'))).toBe(false);
    expect(await listing('input')).toEqual(['a.xml']);
    expect(await listing('archive')).toEqual([]);
    expect(lines.some((l) => l.includes('"level":"warn"') && l.includes('lease lost'))).toBe(true);
  });

  it('refuses the file for good when the commit hits the DocumentId unique constraint', async () => {
    completeError = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', detail: 'Key (document_id)=(SAP-DLV-2026-000123) already exists.' });
    await drop('a.xml');
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ failed: 1, error: null });
    expect(calls.at(-1)).toMatch(/^fail row-\w+ permanent: another file with this DocumentId was imported at the same moment$/);
    expect(await listing('error')).toEqual(['a.xml', 'a.xml.error.json']);
  });

  it('leaves a refused file in place when the refusal finds the row reclaimed', async () => {
    await drop('bad.xml', path.join(FIXTURES, 'malformed.xml'));
    rowTaken = true;
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ skipped: 1, failed: 0, error: null });
    expect(await listing('input')).toEqual(['bad.xml']);
    expect(await listing('error')).toEqual([]);
  });

  it('warns on a missing input directory and runs with nothing', async () => {
    deps.config.dirs.input = path.join(root, 'nope');
    const summary = await runOnce(deps, 'run-1', 'auto');
    expect(summary).toMatchObject({ discovered: 0, processed: 0, error: null });
    expect(lines.some((l) => l.includes('"level":"warn"') && l.includes('input directory is missing'))).toBe(true);
  });
});
