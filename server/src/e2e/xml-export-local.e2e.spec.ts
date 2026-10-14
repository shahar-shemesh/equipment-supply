import './setup-env';

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../app.module';
import { IssuanceStatus, TaskStatus, UserRole, XmlOutboxStatus } from '../../../shared/@core';
import { User, Courier, Issuance, XmlOutbox } from '../entities';
import { xmlExportConfig } from '../env';
import { LocalXmlStorageService } from '../xml-export/local-xml-storage.service';
import { XmlBuilderService } from '../xml-export/xml-builder.service';
import { XmlExportWorker, objectKey } from '../xml-export/xml-export.worker';
import { XML_STORAGE } from '../xml-export/xml-storage';

//the xml export with XML_EXPORT_STORAGE=local, wired end to end: the real application boots with a temporary export
//directory and no bucket, no region and no override of the s3 service, an assign writes its row, the worker is ticked
//by hand and the document is read back from the disk. the local backend itself is covered in
//xml-export/local-xml-storage.service.spec.ts; this spec is about the factory in the module, the config reader and the
//worker meeting a real directory. the timer never starts (XML_EXPORT_ENABLED is blank in setup-env)

let app: INestApplication;
let ds: DataSource;
let worker: XmlExportWorker;
let exportDir: string;

async function ensureTestDatabase() {
    const client = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: +(process.env.DB_PORT || 5433),
        user: process.env.DB_USER || 'equipment',
        password: process.env.DB_PASSWORD || 'equipment',
        database: 'postgres',
    });
    await client.connect();
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [process.env.DB_NAME]);
    if (!exists.rowCount) await client.query(`CREATE DATABASE "${process.env.DB_NAME}"`);
    await client.end();
}

beforeAll(async () => {
    await ensureTestDatabase();
    exportDir = await mkdtemp(path.join(os.tmpdir(), 'xml-export-e2e-'));
    //the local backend and nothing of s3: a developer's .env may hold a bucket, this process must not need one
    process.env.XML_EXPORT_STORAGE = 'local';
    process.env.XML_EXPORT_LOCAL_DIR = exportDir;
    delete process.env.XML_EXPORT_BUCKET;
    delete process.env.AWS_REGION;
    delete process.env.XML_EXPORT_PREFIX;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    ds = app.get(DataSource);
    worker = app.get(XmlExportWorker);
});

afterAll(async () => {
    await app?.close();
    if (exportDir) await rm(exportDir, { recursive: true, force: true });
});

/*──────────────────────────────────────────────────────────────────────────*/

type Fixture = { courier: Courier; managerToken: string };

//one manager with a login and one courier; the issuances are opened per test
async function fixture(): Promise<Fixture> {
    await ds.query('TRUNCATE TABLE xml_outbox, audit_log, delivery_conflicts, delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');
    await rm(exportDir, { recursive: true, force: true });
    await mkdir(exportDir, { recursive: true });
    const hash = await bcrypt.hash('1234', 4);
    await ds.getRepository(User).save({ username: 'm', password_hash: hash, display_name: 'דנה', role: UserRole.manager });
    const courier = await ds.getRepository(Courier).save({ name: 'courier one' });
    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'm', password: '1234' });
    expect(login.body.token).toBeTruthy();
    return { courier, managerToken: login.body.token };
}

function post(path: string, token: string, body: any) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

async function openIssuance() {
    return ds.getRepository(Issuance).save({ sap_number: `70000${10 + (await ds.getRepository(Issuance).count())}`, status: IssuanceStatus.unassigned, customer_name: 'x', address_street: 'y', address_city: 'z' } as any);
}

function rowsOf(issuanceId: number) {
    return ds.getRepository(XmlOutbox).find({ where: { issuance_id: issuanceId }, order: { sequence: 'ASC' } });
}

//every file under the export directory, relative with forward slashes, sorted
async function files(root = exportDir): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) out.push(...(await files(full)));
        else out.push(path.relative(exportDir, full).split(path.sep).join('/'));
    }
    return out.sort();
}

function sha(bytes: Buffer) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function retryNow() {
    await ds.query(`UPDATE xml_outbox SET next_retry_at = now() - interval '1 second' WHERE status = '${XmlOutboxStatus.pending}'`);
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('the wiring', () => {
    it('the worker holds the local backend, the config names the temp directory and no bucket, and the timer never started', () => {
        expect(app.get(XML_STORAGE)).toBeInstanceOf(LocalXmlStorageService);
        expect(xmlExportConfig()).toMatchObject({ enabled: false, storage: 'local', localDir: exportDir, bucket: null, region: null, prefix: 'issuance-status-changes/' });
        expect((worker as any).timer).toBeNull();
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('the worker on a directory', () => {
    it("an assign becomes a file under the row's key with the builder's bytes and a sidecar, the row is completed, and a second pass writes nothing new", async () => {
        const f = await fixture();
        const a = await openIssuance();
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id], courier_id: f.courier.id, scheduled_date: '2026-10-12' })).status).toBe(201);
        const [pending] = await rowsOf(a.id);
        expect(pending.status).toBe(XmlOutboxStatus.pending);

        expect(await worker.tick()).toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0, lost: 0 });
        const [row] = await rowsOf(a.id);
        const key = objectKey('issuance-status-changes/', row);
        const today = new Date(row.occurred_at).toISOString().slice(0, 10).replace(/-/g, '/');
        expect(key).toBe(`issuance-status-changes/${today}/issuance_${a.id}_${row.id}.xml`);
        expect(row).toMatchObject({ status: XmlOutboxStatus.completed, attempts: 1, s3_key: key, lease_until: null, last_error: null });

        expect(await files()).toEqual([key, `${key}.meta.json`]);
        const bytes = await readFile(path.join(exportDir, key));
        const built = app.get(XmlBuilderService).build(row);
        expect(bytes.toString('utf8')).toBe(built.xml);
        expect(sha(bytes)).toBe(row.content_sha256);
        expect(bytes.toString('utf8')).toContain(`<EventId>${row.id}</EventId>`);
        expect(JSON.parse(await readFile(path.join(exportDir, `${key}.meta.json`), 'utf8'))).toEqual({ 'event-id': row.id, 'issuance-id': String(a.id), sequence: '1', 'content-sha256': row.content_sha256 });

        //the same row again (a lease that ran out, a retry by hand): the put meets its own file, the head matches, the
        //directory holds the one xml and the one sidecar, the row is completed again
        await ds.getRepository(XmlOutbox).update(row.id, { status: XmlOutboxStatus.pending, processed_at: null, s3_key: null, content_sha256: null });
        await retryNow();
        expect(await worker.tick()).toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0, lost: 0 });
        expect((await rowsOf(a.id))[0]).toMatchObject({ status: XmlOutboxStatus.completed, attempts: 2, s3_key: key, content_sha256: row.content_sha256 });
        expect(await files()).toEqual([key, `${key}.meta.json`]);
        expect(await readFile(path.join(exportDir, key))).toEqual(bytes);

        //a tick with nothing to do writes nothing
        expect(await worker.tick()).toEqual({ claimed: 0, completed: 0, retried: 0, failed: 0, lost: 0 });
        expect(await files()).toEqual([key, `${key}.meta.json`]);
    });

    it('a file with other bytes under the key stays as it is: failed as a collision without a sidecar, completed with the stored hash when the sidecar names the event', async () => {
        const f = await fixture();
        const a = await openIssuance();
        const b = await openIssuance();
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id, b.id], courier_id: f.courier.id })).status).toBe(201);
        const [rowA] = await rowsOf(a.id);
        const [rowB] = await rowsOf(b.id);
        const keyA = objectKey('issuance-status-changes/', rowA);
        const keyB = objectKey('issuance-status-changes/', rowB);
        await mkdir(path.dirname(path.join(exportDir, keyA)), { recursive: true });
        await writeFile(path.join(exportDir, keyA), '<copied in by hand/>');
        await writeFile(path.join(exportDir, keyB), '<earlier rendering/>');
        await writeFile(path.join(exportDir, `${keyB}.meta.json`), JSON.stringify({ 'event-id': rowB.id, 'issuance-id': String(b.id), sequence: '1', 'content-sha256': 'stale' }));

        expect(await worker.tick()).toEqual({ claimed: 2, completed: 1, retried: 0, failed: 1, lost: 0 });
        const failedA = (await rowsOf(a.id))[0];
        expect(failedA.status).toBe(XmlOutboxStatus.failed);
        expect(failedA.last_error).toBe(`key_collision: ${keyA} holds event ? sha256 ${sha(Buffer.from('<copied in by hand/>'))}`);
        const doneB = (await rowsOf(b.id))[0];
        expect(doneB).toMatchObject({ status: XmlOutboxStatus.completed, s3_key: keyB, content_sha256: sha(Buffer.from('<earlier rendering/>')) });
        expect(await files()).toEqual([keyA, keyB, `${keyB}.meta.json`]);
        expect((await readFile(path.join(exportDir, keyA))).toString()).toBe('<copied in by hand/>');
        expect((await readFile(path.join(exportDir, keyB))).toString()).toBe('<earlier rendering/>');
    });
});
