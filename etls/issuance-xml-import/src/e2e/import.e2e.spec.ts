import * as fs from 'fs/promises';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditAction, AuditActorType, AuditEntityType, IssuanceStatus, Priority } from '../../../../shared/@core';
import { importFilesRepository } from '../repositories/import-files.repository';
import { issuancesRepository } from '../repositories/issuances.repository';
import { PipelineDeps, runOnce } from '../services/pipeline';
import { RetryableError } from '../utils/errors';
import { DocIssuance, createTestSchema, makeDeps, sha256, tempDirs, testPool, truncateAll, xmlDocument } from './setup';

//the rows of the matrix on the real database: what one run leaves in issuances, issuance_items, audit_log,
//xml_import_files and xml_outbox, and where the file ends up

const pool = testPool();
let dirs: PipelineDeps['config']['dirs'];
let root: string;
let deps: PipelineDeps;
let runs = 0;

const base: DocIssuance = {
  sap: '2000592',
  prefix: "ד'",
  priority: 'normal',
  date: '2026-10-30',
  customer: { name: 'ישראל ישראלי', id: '012345678', phone: '050-1234567' },
  address: { street: 'הרצל 12', building: 'בניין B קומה 3', city: 'תל אביב' },
  notes: 'להתקשר לפני & לעלות',
  items: [
    { line: 1, product: 'מחשב IEXXX', catalog: 'PKG-1102', station: '1104', serial: 'SN1', qty: 1 },
    { line: 2, product: 'מסך 24"', catalog: 'PKG-2201', qty: 2 },
  ],
};

beforeAll(async () => {
  await createTestSchema();
  ({ root, dirs } = await tempDirs());
  deps = makeDeps(pool, dirs);
});

afterAll(async () => {
  await pool.end();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(pool);
  for (const dir of Object.values(dirs)) {
    for (const name of await fs.readdir(dir)) await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }
});

async function drop(name: string, content: string) {
  await fs.writeFile(path.join(dirs.input, name), content, 'utf8');
}

const run = (d: PipelineDeps = deps) => runOnce(d, `run-${++runs}`, 'auto');
const listing = (dir: string) => fs.readdir(dir).then((n) => n.sort());
const one = async <T = any>(sql: string, params: unknown[] = []): Promise<T> => (await pool.query(sql, params)).rows[0];
const all = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows;
const count = async (table: string) => +(await one(`SELECT count(*)::int AS n FROM ${table}`)).n;
const issuanceOf = (sap: string) => one(`SELECT *, delivery_date::text AS delivery_date FROM issuances WHERE sap_number = $1`, [sap]);
const itemsOf = (id: number) => all(`SELECT line_no, product_name, catalog_number, station_number, serial_number, quantity, removed_at FROM issuance_items WHERE issuance_id = $1 ORDER BY line_no`, [id]);
const fileRows = () => all(`SELECT * FROM xml_import_files ORDER BY created_at`);

describe('a new document', () => {
  it('inserts the issuance with its items, one audit row, a completed tracking row, and archives the file; the outbox stays empty', async () => {
    const xml = xmlDocument({ id: 'SAP-DLV-1', issuances: [base] });
    await drop('one.xml', xml);
    const summary = await run();
    expect(summary).toMatchObject({ discovered: 1, processed: 1, succeeded: 1, failed: 0, error: null });

    const issuance = await issuanceOf('2000592');
    expect(issuance).toMatchObject({ status: IssuanceStatus.unassigned, source: 'sap', revision: 1, priority: Priority.normal, number_prefix: "ד'", delivery_date: '2026-10-30', customer_name: 'ישראל ישראלי', customer_id_number: '012345678', customer_phone: '050-1234567', address_street: 'הרצל 12', address_building: 'בניין B קומה 3', address_city: 'תל אביב', notes: 'להתקשר לפני & לעלות', self_pickup: false, deleted_at: null, delivered_by_user_id: null });
    expect(await itemsOf(issuance.id)).toEqual([
      { line_no: 1, product_name: 'מחשב IEXXX', catalog_number: 'PKG-1102', station_number: '1104', serial_number: 'SN1', quantity: 1, removed_at: null },
      { line_no: 2, product_name: 'מסך 24"', catalog_number: 'PKG-2201', station_number: null, serial_number: null, quantity: 2, removed_at: null },
    ]);

    const [file] = await fileRows();
    expect(file).toMatchObject({ content_sha256: sha256(xml), document_id: 'SAP-DLV-1', file_name: 'one.xml', size_bytes: Buffer.byteLength(xml), status: 'completed', error_kind: null, attempts: 1, instance_id: 'etl-test', lease_until: null, inserted: 1, updated: 0, unchanged: 0, last_error: null });
    expect(file.finished_at).toBeInstanceOf(Date);

    const audit = await all(`SELECT * FROM audit_log`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: AuditActorType.system, actor_user_id: null, actor_username: null, actor_role: null, action: AuditAction.issuance_import, entity_type: AuditEntityType.issuance, entity_id: issuance.id, issuance_id: issuance.id, batch_id: file.id, details: { sap_number: '2000592', mode: 'insert', changed: [], file: 'one.xml', document_id: 'SAP-DLV-1' } });
    expect(await count('xml_outbox')).toBe(0);
    expect(await listing(dirs.input)).toEqual([]);
    expect(await listing(dirs.archive)).toEqual(['one.xml']);
  });

  it('decodes the special characters into the columns', async () => {
    await drop('chars.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [{ ...base, customer: { name: "O'Brien & Sons <ltd>" }, notes: undefined, extra: '<Notes><![CDATA[<b>raw</b> & more]]></Notes>' }] }));
    expect((await run()).succeeded).toBe(1);
    const issuance = await issuanceOf('2000592');
    expect(issuance.customer_name).toBe("O'Brien & Sons <ltd>");
    expect(issuance.notes).toBe('<b>raw</b> & more');
  });
});

describe('the same bytes again', () => {
  it('is archived under a free name without a claim or any table change, under the old name and a new one', async () => {
    const xml = xmlDocument({ id: 'SAP-DLV-1', issuances: [base] });
    await drop('one.xml', xml);
    await run();
    const before = { issuance: await issuanceOf('2000592'), audit: await count('audit_log'), files: await fileRows() };

    await drop('one.xml', xml);
    await drop('copy-of-one.xml', xml);
    const summary = await run();
    expect(summary).toMatchObject({ discovered: 2, processed: 2, already_imported: 2, succeeded: 0 });
    expect(await issuanceOf('2000592')).toEqual(before.issuance);
    expect(await count('audit_log')).toBe(before.audit);
    expect(await fileRows()).toEqual(before.files);
    expect(await listing(dirs.archive)).toEqual(['copy-of-one.xml', 'one.1.xml', 'one.xml']);
  });
});

describe('an existing issuance', () => {
  async function seeded(status = IssuanceStatus.unassigned) {
    await drop('seed.xml', xmlDocument({ id: 'SAP-DLV-SEED', issuances: [base] }));
    await run();
    const issuance = await issuanceOf('2000592');
    if (status !== IssuanceStatus.unassigned) await pool.query(`UPDATE issuances SET status = $2 WHERE id = $1`, [issuance.id, status]);
    //the clock moves, so updated_at can be seen to change
    await pool.query(`UPDATE issuances SET updated_at = updated_at - interval '1 hour' WHERE id = $1`, [issuance.id]);
    return issuanceOf('2000592');
  }

  it('updates a changed phone with updated_at and the revision, and records the changed columns', async () => {
    const before = await seeded();
    await drop('phone.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [{ ...base, customer: { ...base.customer, phone: '052-7654321' } }] }));
    const summary = await run();
    expect(summary).toMatchObject({ succeeded: 1 });
    const after = await issuanceOf('2000592');
    expect(after.customer_phone).toBe('052-7654321');
    expect(after.revision).toBe(before.revision + 1);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    expect(after.created_at).toEqual(before.created_at);
    const audit = await one(`SELECT details FROM audit_log ORDER BY id DESC LIMIT 1`);
    expect(audit.details).toEqual({ sap_number: '2000592', mode: 'update', changed: ['customer_phone'], file: 'phone.xml', document_id: 'SAP-DLV-2', revision_bumped: true });
    expect((await fileRows()).at(-1)).toMatchObject({ document_id: 'SAP-DLV-2', inserted: 0, updated: 1, unchanged: 0 });
  });

  it('updates the priority alone without a revision bump', async () => {
    const before = await seeded();
    await drop('prio.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [{ ...base, priority: 'urgent' }] }));
    await run();
    const after = await issuanceOf('2000592');
    expect(after.priority).toBe(Priority.urgent);
    expect(after.revision).toBe(before.revision);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('leaves an absent optional element alone and counts the issuance as unchanged', async () => {
    const before = await seeded();
    const { notes, prefix, date, ...without } = base;
    await drop('less.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [{ ...without, customer: { name: base.customer.name }, items: base.items.map(({ line, product }) => ({ line, product })) }] }));
    const summary = await run();
    expect(summary).toMatchObject({ succeeded: 1 });
    const after = await issuanceOf('2000592');
    expect(after).toEqual(before);
    expect((await fileRows()).at(-1)).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(await count('audit_log')).toBe(1);
  });

  it('applies the lines: a gone line removed, a new one inserted, a changed one updated, the revision bumped', async () => {
    const before = await seeded();
    await drop('items.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [{ ...base, items: [{ ...base.items[0], qty: 5 }, { line: 3, product: 'מקלדת' }] }] }));
    await run();
    const after = await issuanceOf('2000592');
    expect(after.revision).toBe(before.revision + 1);
    const items = await itemsOf(after.id);
    expect(items.map((i) => [i.line_no, i.quantity, i.removed_at === null])).toEqual([
      [1, 5, true],
      [2, 2, false],
      [3, 1, true],
    ]);
    expect(items[1].removed_at).toBeInstanceOf(Date);
    const audit = await one(`SELECT details FROM audit_log ORDER BY id DESC LIMIT 1`);
    expect(audit.details.changed).toEqual(['items[3].inserted', 'items[1].quantity', 'items[2].removed']);
  });

  it('restores a removed line that comes back', async () => {
    const before = await seeded();
    await pool.query(`UPDATE issuance_items SET removed_at = now() WHERE issuance_id = $1 AND line_no = 2`, [before.id]);
    await drop('back.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [base] }));
    await run();
    const after = await issuanceOf('2000592');
    expect(after.revision).toBe(before.revision + 1);
    expect((await itemsOf(after.id)).map((i) => i.removed_at)).toEqual([null, null]);
    expect((await one(`SELECT details FROM audit_log ORDER BY id DESC LIMIT 1`)).details.changed).toEqual(['items[2].restored']);
  });

  it('refuses the whole file when a delivered issuance differs: the new issuance of the same file is rolled back', async () => {
    const before = await seeded(IssuanceStatus.delivered);
    const xml = xmlDocument({ id: 'SAP-DLV-2', issuances: [{ ...base, sap: '2000593' }, { ...base, customer: { ...base.customer, phone: '000' } }] });
    await drop('two.xml', xml);
    const summary = await run();
    expect(summary).toMatchObject({ failed: 1, succeeded: 0, error: null });
    expect(await issuanceOf('2000593')).toBeUndefined();
    expect(await issuanceOf('2000592')).toEqual(before);
    expect(await count('audit_log')).toBe(1);
    expect((await fileRows()).at(-1)).toMatchObject({ content_sha256: sha256(xml), status: 'failed', error_kind: 'permanent', document_id: null, last_error: 'issuance 2000592 is delivered, the document cannot change it' });
    expect(await listing(dirs.error)).toEqual(['two.xml', 'two.xml.error.json']);
    expect(JSON.parse(await fs.readFile(path.join(dirs.error, 'two.xml.error.json'), 'utf8'))).toMatchObject({ file: 'two.xml', sha256: sha256(xml), error: 'issuance 2000592 is delivered, the document cannot change it' });
  });

  it('updates an assigned issuance (a courier holds it) like an unassigned one, with the revision bump', async () => {
    const before = await seeded(IssuanceStatus.assigned);
    await drop('phone.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [{ ...base, customer: { ...base.customer, phone: '052-7654321' } }] }));
    expect(await run()).toMatchObject({ succeeded: 1, failed: 0 });
    const after = await issuanceOf('2000592');
    expect(after).toMatchObject({ status: IssuanceStatus.assigned, customer_phone: '052-7654321', revision: before.revision + 1 });
    expect((await fileRows()).at(-1)).toMatchObject({ status: 'completed', updated: 1 });
  });

  it('refuses a line added or restored on an assigned issuance, and allows the same document once it is unassigned', async () => {
    const before = await seeded(IssuanceStatus.assigned);
    const withLine3 = { ...base, items: [...base.items, { line: 3, product: 'מקלדת', qty: 1 }] };
    await drop('line3.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [withLine3] }));
    expect(await run()).toMatchObject({ failed: 1, succeeded: 0 });
    expect(await issuanceOf('2000592')).toEqual(before);
    expect(await itemsOf(before.id)).toHaveLength(2);
    expect((await fileRows()).at(-1)).toMatchObject({ status: 'failed', error_kind: 'permanent', last_error: 'issuance 2000592 is assigned, the document adds line 3 while a courier holds it' });

    //the manager took line 2 off, the document brings it back: the same refusal
    await pool.query(`UPDATE issuance_items SET removed_at = now() WHERE issuance_id = $1 AND line_no = 2`, [before.id]);
    await drop('restore.xml', xmlDocument({ id: 'SAP-DLV-3', issuances: [base] }));
    expect(await run()).toMatchObject({ failed: 1, succeeded: 0 });
    expect((await fileRows()).at(-1)).toMatchObject({ status: 'failed', last_error: 'issuance 2000592 is assigned, the document adds line 2 while a courier holds it' });

    //back in the warehouse (not delivered): the same bytes dropped again go through
    await pool.query(`UPDATE issuances SET status = $2 WHERE id = $1`, [before.id, IssuanceStatus.not_delivered]);
    await fs.copyFile(path.join(dirs.error, 'line3.xml'), path.join(dirs.input, 'line3.xml'));
    expect(await run()).toMatchObject({ succeeded: 1, failed: 0 });
    expect((await itemsOf(before.id)).map((i) => [i.line_no, i.removed_at === null])).toEqual([[1, true], [2, true], [3, true]]);
    expect((await issuanceOf('2000592')).revision).toBe(before.revision + 1);
  });

  it('refuses a differing document on a deleted issuance', async () => {
    const before = await seeded(IssuanceStatus.deleted);
    await drop('phone.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [{ ...base, customer: { ...base.customer, phone: '052-7654321' } }] }));
    expect(await run()).toMatchObject({ failed: 1, succeeded: 0 });
    expect(await issuanceOf('2000592')).toEqual(before);
    expect((await fileRows()).at(-1)).toMatchObject({ status: 'failed', error_kind: 'permanent', last_error: 'issuance 2000592 is deleted, the document cannot change it' });
    expect(await listing(dirs.error)).toEqual(['phone.xml', 'phone.xml.error.json']);
  });

  it('counts an identical document as unchanged whatever the status', async () => {
    const before = await seeded(IssuanceStatus.partially_delivered);
    await drop('same.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [base] }));
    expect(await run()).toMatchObject({ succeeded: 1 });
    expect(await issuanceOf('2000592')).toEqual(before);
    expect((await fileRows()).at(-1)).toMatchObject({ status: 'completed', unchanged: 1 });
    expect(await listing(dirs.archive)).toEqual(['same.xml', 'seed.xml']);
  });

  it('never writes an outbox row: the status is not the document\'s to move', async () => {
    await seeded();
    await drop('again.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [{ ...base, priority: 'urgent', customer: { name: 'אחר' } }] }));
    await run();
    expect(await count('xml_outbox')).toBe(0);
    expect((await issuanceOf('2000592')).status).toBe(IssuanceStatus.unassigned);
  });
});

describe('refusals before the transaction', () => {
  it('leaves nothing of the first issuance when the second violates the contract', async () => {
    await drop('bad.xml', xmlDocument({ id: 'SAP-DLV-3', issuances: [base, { ...base, sap: '2000593', priority: 'high' }] }));
    const summary = await run();
    expect(summary).toMatchObject({ failed: 1 });
    expect(await count('issuances')).toBe(0);
    expect(await count('audit_log')).toBe(0);
    expect((await fileRows())[0]).toMatchObject({ status: 'failed', error_kind: 'permanent', last_error: 'Issuances/Issuance[2]/Priority must be normal or urgent' });
    expect(await listing(dirs.error)).toEqual(['bad.xml', 'bad.xml.error.json']);
  });

  it('refuses a second file under a DocumentId another file completed, before any write', async () => {
    await drop('a.xml', xmlDocument({ id: 'SAP-DLV-9', issuances: [base] }));
    await run();
    await drop('b.xml', xmlDocument({ id: 'SAP-DLV-9', issuances: [{ ...base, sap: '2000600' }] }));
    const summary = await run();
    expect(summary).toMatchObject({ failed: 1 });
    expect(await issuanceOf('2000600')).toBeUndefined();
    expect((await fileRows()).at(-1)).toMatchObject({ file_name: 'b.xml', status: 'failed', error_kind: 'permanent', document_id: null, last_error: 'document SAP-DLV-9 was imported from file a.xml already' });
    expect(await listing(dirs.error)).toEqual(['b.xml', 'b.xml.error.json']);
  });

  it('refuses an oversized file without reading it', async () => {
    const small = makeDeps(pool, dirs, { config: { maxFileBytes: 100 } });
    await drop('big.xml', xmlDocument({ id: 'SAP-DLV-4', issuances: [base] }));
    expect(await run(small)).toMatchObject({ failed: 1 });
    expect((await fileRows())[0]).toMatchObject({ status: 'failed', error_kind: 'permanent', file_name: 'big.xml' });
    expect((await fileRows())[0].last_error).toMatch(/^the file is \d+ bytes, the limit is 100$/);
    expect(await listing(dirs.error)).toEqual(['big.xml', 'big.xml.error.json']);
  });
});

describe('crashes and claims', () => {
  it('archives a file whose commit went through but whose archive failed, without a second audit row', async () => {
    //the archive directory is gone when the first run tries to move the file: the commit is done, the file stays
    await fs.rm(dirs.archive, { recursive: true });
    await drop('one.xml', xmlDocument({ id: 'SAP-DLV-1', issuances: [base] }));
    expect(await run()).toMatchObject({ succeeded: 1 });
    expect(await listing(dirs.input)).toEqual(['one.xml']);
    expect((await fileRows())[0].status).toBe('completed');
    await fs.mkdir(dirs.archive);
    expect(await run()).toMatchObject({ already_imported: 1, succeeded: 0 });
    expect(await listing(dirs.input)).toEqual([]);
    expect(await listing(dirs.archive)).toEqual(['one.xml']);
    expect(await count('audit_log')).toBe(1);
  });

  it('skips a file whose row is processing under a live lease and reclaims it once the lease ran out', async () => {
    const xml = xmlDocument({ id: 'SAP-DLV-1', issuances: [base] });
    await drop('one.xml', xml);
    await pool.query(`INSERT INTO xml_import_files (content_sha256, file_name, size_bytes, status, instance_id, lease_until, attempts) VALUES ($1, 'one.xml', 1, 'processing', 'etl-other', now() + interval '1 hour', 1)`, [sha256(xml)]);
    expect(await run()).toMatchObject({ skipped: 1, processed: 0 });
    expect(await count('issuances')).toBe(0);
    await pool.query(`UPDATE xml_import_files SET lease_until = now() - interval '1 second'`);
    expect(await run()).toMatchObject({ succeeded: 1 });
    expect((await fileRows())[0]).toMatchObject({ status: 'completed', attempts: 2, instance_id: 'etl-test' });
  });

  it('gives exactly one of two concurrent claims the row', async () => {
    const input = { sha256: 'a'.repeat(64), fileName: 'x.xml', sizeBytes: 10, leaseMs: 60000 };
    const [a, b] = await Promise.all([importFilesRepository.claim(pool, { ...input, instanceId: 'etl-a' }), importFilesRepository.claim(pool, { ...input, instanceId: 'etl-b' })]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await count('xml_import_files')).toBe(1);
    //a third claim after the lease is released takes it over and counts the attempt
    await pool.query(`UPDATE xml_import_files SET lease_until = NULL`);
    const c = await importFilesRepository.claim(pool, { ...input, instanceId: 'etl-c' });
    expect(c).toMatchObject({ attempts: 2, instance_id: 'etl-c', status: 'processing' });
  });

  it('keeps the file and marks the row retryable on a transient failure, then imports it on a later run', async () => {
    let fail = true;
    const flaky = makeDeps(pool, dirs, {
      issuances: {
        ...issuancesRepository,
        lockBySapNumber: (client, sap) => {
          if (fail) throw new RetryableError('connection reset', { code: 'ECONNRESET' });
          return issuancesRepository.lockBySapNumber(client, sap);
        },
      },
    });
    await drop('one.xml', xmlDocument({ id: 'SAP-DLV-1', issuances: [base] }));
    await drop('two.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [{ ...base, sap: '2000593' }] }));
    const summary = await run(flaky);
    expect(summary).toMatchObject({ discovered: 2, processed: 0, succeeded: 0, failed: 0, error: 'one.xml: connection reset' });
    expect(await listing(dirs.input)).toEqual(['one.xml', 'two.xml']);
    expect(await count('issuances')).toBe(0);
    expect(await fileRows()).toMatchObject([{ file_name: 'one.xml', status: 'failed', error_kind: 'retryable', last_error: 'connection reset', lease_until: null, attempts: 1 }]);

    fail = false;
    //the failed file waits for its backoff (10 s after the first failure); the file behind it goes through
    expect(await run(flaky)).toMatchObject({ skipped: 1, succeeded: 1, error: null });
    expect(await listing(dirs.input)).toEqual(['one.xml']);
    await pool.query(`UPDATE xml_import_files SET finished_at = now() - interval '1 minute' WHERE file_name = 'one.xml'`);
    expect(await run(flaky)).toMatchObject({ succeeded: 1, error: null });
    expect(await fileRows()).toMatchObject([{ file_name: 'one.xml', status: 'completed', attempts: 2, error_kind: null, last_error: null }, { file_name: 'two.xml', status: 'completed', attempts: 1 }]);
    expect(await count('issuances')).toBe(2);
  });

  it('rolls the import back and leaves the file when its row was reclaimed under the lease', async () => {
    const stolen = makeDeps(pool, dirs, {
      issuances: {
        ...issuancesRepository,
        lockBySapNumber: async (client, sap) => {
          //another instance took the row over while this one works (its lease ran out)
          await pool.query(`UPDATE xml_import_files SET instance_id = 'etl-other', lease_until = now() + interval '1 hour', attempts = attempts + 1 WHERE status = 'processing'`);
          return issuancesRepository.lockBySapNumber(client, sap);
        },
      },
    });
    await drop('one.xml', xmlDocument({ id: 'SAP-DLV-1', issuances: [base] }));
    expect(await run(stolen)).toMatchObject({ discovered: 1, processed: 0, skipped: 1, succeeded: 0, failed: 0, error: null });
    expect(await count('issuances')).toBe(0);
    expect(await count('audit_log')).toBe(0);
    expect(await listing(dirs.input)).toEqual(['one.xml']);
    expect((await fileRows())[0]).toMatchObject({ status: 'processing', instance_id: 'etl-other', attempts: 2, document_id: null });
  });

  it('turns a transient failure past the attempts limit into a permanent refusal', async () => {
    const flaky = makeDeps(pool, dirs, {
      config: { maxAttempts: 2 },
      issuances: {
        ...issuancesRepository,
        lockBySapNumber: () => {
          throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        },
      },
    });
    await drop('one.xml', xmlDocument({ id: 'SAP-DLV-1', issuances: [base] }));
    expect((await run(flaky)).error).toBe('one.xml: deadlock detected');
    expect(await listing(dirs.input)).toEqual(['one.xml']);
    expect(await run(flaky)).toMatchObject({ skipped: 1, failed: 0, error: null }); //inside the backoff
    await pool.query(`UPDATE xml_import_files SET finished_at = now() - interval '1 minute'`);
    expect(await run(flaky)).toMatchObject({ failed: 1, error: null });
    expect((await fileRows())[0]).toMatchObject({ status: 'failed', error_kind: 'permanent', attempts: 2, last_error: 'attempts exhausted (2): deadlock detected' });
    expect(await listing(dirs.error)).toEqual(['one.xml', 'one.xml.error.json']);
  });

  it('serializes two imports of the same issuance through the row lock', async () => {
    await drop('seed.xml', xmlDocument({ id: 'SAP-DLV-SEED', issuances: [base] }));
    await run();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM issuances WHERE sap_number = '2000592' FOR UPDATE`);
      await drop('phone.xml', xmlDocument({ id: 'SAP-DLV-2', issuances: [{ ...base, customer: { ...base.customer, phone: '1' } }] }));
      let done = false;
      const running = run().then((s) => {
        done = true;
        return s;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false);
      await client.query('COMMIT');
      expect(await running).toMatchObject({ succeeded: 1 });
    } finally {
      client.release();
    }
    expect((await issuanceOf('2000592')).customer_phone).toBe('1');
  });
});
