import './setup-env';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource, IsNull } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../app.module';
import { tokenFor } from './auth-helper';
import { AuditAction, AuditActorType, IXmlExportOverview, IssuanceStatus, NonDeliveryReason, Priority, RecipientType, TaskStatus, UserRole, XmlOutboxStatus } from '../../../shared/@core';
import { User, Courier, Issuance, DeliveryTask, AuditLog, XmlOutbox } from '../entities';
import { SAMPLE_SIGNATURE } from '../seed/seed.data';
import { S3StorageService, StorageError } from '../xml-export/s3-storage.service';
import { XmlBuilderService } from '../xml-export/xml-builder.service';
import { XmlExportWorker, objectKey } from '../xml-export/xml-export.worker';
import { XML_STORAGE } from '../xml-export/xml-storage';
import { XmlOutboxService } from '../xml-export/xml-outbox.service';

//the xml export against the same throwaway database as the other e2e specs: every status writing route of the matrix
//in docs/plans/xml-export-outbox.md leaves its outbox row (or none), then the worker is ticked by hand against an
//in-memory bucket: the happy path, the retries, the lease, the 412 reconciliation, two claims at once, the manager's
//endpoints. the worker's timer never starts here (XML_EXPORT_ENABLED is blank in setup-env)

//what the worker sees instead of s3. a script of outcomes for the next puts, 'ok' when the script runs out.
//store_then_timeout keeps the object and throws anyway: the upload went through and the response was lost
type PutStep = 'ok' | 'transient' | 'config' | 'store_then_timeout';

class FakeStorage {
    objects = new Map<string, { body: string; metadata: Record<string, string> }>();
    script: PutStep[] = [];
    puts = 0;
    heads = 0;

    async putIfAbsent(key: string, body: Buffer, metadata: Record<string, string>) {
        this.puts++;
        const step = this.script.shift() || 'ok';
        if (step === 'transient') throw new StorageError('transient', 'ServiceUnavailable: 503');
        if (step === 'config') throw new StorageError('transient', 'AccessDenied: 403', true);
        if (this.objects.has(key)) throw new StorageError('precondition', 'PreconditionFailed: 412');
        this.objects.set(key, { body: body.toString('utf8'), metadata });
        if (step === 'store_then_timeout') throw new StorageError('transient', 'TimeoutError: response lost');
    }

    async head(key: string) {
        this.heads++;
        const o = this.objects.get(key);
        return o ? { metadata: o.metadata } : null;
    }

    reset() {
        this.objects.clear();
        this.script = [];
        this.puts = 0;
        this.heads = 0;
    }
}

let app: INestApplication;
let ds: DataSource;
let worker: XmlExportWorker;
let outbox: XmlOutboxService;
const storage = new FakeStorage();

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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(S3StorageService).useValue(storage).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    ds = app.get(DataSource);
    worker = app.get(XmlExportWorker);
    outbox = app.get(XmlOutboxService);
});

afterAll(async () => {
    await app?.close();
});

/*──────────────────────────────────────────────────────────────────────────*/

type Fixture = { issuance: Issuance; task: DeliveryTask; manager: User; courierUser: User; courier: Courier; otherCourier: Courier; managerToken: string; courierToken: string; itemIds: number[] };

const OP_A = 'a0d17000-0000-4000-8000-000000000001';

//one manager, one courier with a login, one courier without, one issuance with two lines assigned to the first courier
async function fixture(): Promise<Fixture> {
    await ds.query('TRUNCATE TABLE xml_outbox, audit_log, delivery_conflicts, delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');
    storage.reset();

    const manager = await ds.getRepository(User).save({ username: 'm', display_name: 'דנה', role: UserRole.manager });
    const courierUser = await ds.getRepository(User).save({ username: 'c', display_name: 'courier', role: UserRole.courier });
    const courier = await ds.getRepository(Courier).save({ name: 'courier one', user_id: courierUser.id });
    const otherCourier = await ds.getRepository(Courier).save({ name: 'courier two' });

    const issuance = await ds.getRepository(Issuance).save({
        sap_number: '7000001',
        number_prefix: "ס'",
        status: IssuanceStatus.assigned,
        customer_name: 'ישראל ישראלי',
        customer_id_number: '012345678',
        customer_phone: '050-1234567',
        address_street: 'הרצל 10',
        address_city: 'תל אביב',
        delivery_date: '2026-10-20',
        items: [
            { line_no: 1, product_name: 'מחשב', quantity: 1 },
            { line_no: 2, product_name: 'מקלדת', quantity: 1 },
        ],
    } as any);
    const task = await ds.getRepository(DeliveryTask).save({ issuance_id: issuance.id, courier_id: courier.id, status: TaskStatus.pending });

    const login = (username: string) => tokenFor(app, username);
    const f = { issuance, task, manager, courierUser, courier, otherCourier, managerToken: await login('m'), courierToken: await login('c'), itemIds: issuance.items.map((i) => i.id) };
    expect(f.managerToken && f.courierToken).toBeTruthy();
    return f;
}

function post(path: string, token: string, body: any) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

function patch(path: string, token: string, body: any) {
    return request(app.getHttpServer()).patch(path).set('Authorization', `Bearer ${token}`).send(body);
}

function del(path: string, token: string, body: any) {
    return request(app.getHttpServer()).delete(path).set('Authorization', `Bearer ${token}`).send(body);
}

function get(path: string, token: string) {
    return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
}

async function openIssuance(extra: any = {}) {
    return ds.getRepository(Issuance).save({ sap_number: `70000${10 + (await ds.getRepository(Issuance).count())}`, status: IssuanceStatus.unassigned, customer_name: 'x', address_street: 'y', address_city: 'z', ...extra } as any);
}

//the report the tablet signed: everything delivered, against revision 1
function report(f: Fixture, over: any = {}) {
    return { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: f.itemIds.map((item_id) => ({ item_id, delivered: true })), operation_id: OP_A, issuance_revision: 1, client_reported_at: '2026-09-29T08:00:00.000Z', ...over };
}

//the rows of one issuance in sequence order, or every row
function rowsOf(issuanceId?: number) {
    return ds.getRepository(XmlOutbox).find({ where: issuanceId ? { issuance_id: issuanceId } : {}, order: { created_at: 'ASC', sequence: 'ASC' } });
}

async function rowCount() {
    return ds.getRepository(XmlOutbox).count();
}

//the backoff of a failed attempt is seconds to minutes; the spec does not wait, it moves the retry time back
async function retryNow() {
    await ds.query(`UPDATE xml_outbox SET next_retry_at = now() - interval '1 second' WHERE status = '${XmlOutboxStatus.pending}'`);
}

async function overview(token: string): Promise<IXmlExportOverview> {
    const res = await get('/api/xml-export', token);
    expect(res.status).toBe(200);
    return res.body;
}

//the customer never leaves: not in the row, not in the document
function expectNoCustomer(text: string) {
    for (const leaked of ['ישראל', '012345678', '050-1234567', 'הרצל', 'תל אביב', 'iVBOR', 'customer', 'address', 'signature', 'recipient']) expect(text).not.toContain(leaked);
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('what the routes write', () => {
    it('a bulk assign writes one pending row per issuance whose status moved, none for a reassign, and a refused batch writes nothing', async () => {
        const f = await fixture();
        const a = await openIssuance();
        const b = await openIssuance({ status: IssuanceStatus.not_delivered });
        const c = await openIssuance();

        const res = await post('/api/issuances/assign', f.managerToken, { ids: [c.id, b.id, f.issuance.id, a.id], courier_id: f.otherCourier.id, scheduled_date: '2026-10-12' });
        expect(res.status).toBe(201);

        const rows = await rowsOf();
        expect(rows.map((r) => r.issuance_id).sort((x, y) => x - y)).toEqual([a.id, b.id, c.id]); //f.issuance was assigned already: same status, no row
        const open = await ds.getRepository(DeliveryTask).find({ where: { status: TaskStatus.pending } });
        for (const r of rows) {
            expect(r).toMatchObject({ sequence: 1, new_status: IssuanceStatus.assigned, trigger: AuditAction.issuance_assign, status: XmlOutboxStatus.pending, attempts: 0, lease_until: null, processed_at: null, s3_key: null, content_sha256: null, last_error: null });
            expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
            expect(r.payload.actor).toEqual({ type: AuditActorType.user, user_id: f.manager.id, username: 'm', role: UserRole.manager });
            expect(r.payload.issuance).toMatchObject({ id: r.issuance_id, self_pickup: false, revision: 2, delivery_date: '2026-10-12', priority: Priority.normal });
            expect(Object.keys(r.payload.issuance).sort()).toEqual(['delivery_date', 'id', 'number_prefix', 'priority', 'revision', 'sap_number', 'self_pickup']);
            expect(r.payload.details).toEqual({ courier_id: f.otherCourier.id, task_id: open.find((t) => t.issuance_id === r.issuance_id).id, scheduled_date: '2026-10-12' });
            expect(r.next_retry_at.getTime()).toBeLessThanOrEqual(Date.now());
            expectNoCustomer(JSON.stringify(r.payload));
        }
        expect(rows.find((r) => r.issuance_id === a.id).previous_status).toBe(IssuanceStatus.unassigned);
        expect(rows.find((r) => r.issuance_id === b.id).previous_status).toBe(IssuanceStatus.not_delivered);

        //a second assign of a: assigned to assigned, no row; of b after it was moved to not delivered by hand: a second sequence
        await ds.getRepository(Issuance).update(b.id, { status: IssuanceStatus.not_delivered });
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id, b.id], courier_id: f.courier.id })).status).toBe(201);
        expect(await rowsOf(a.id)).toHaveLength(1);
        const bRows = await rowsOf(b.id);
        expect(bRows.map((r) => [r.sequence, r.previous_status, r.new_status])).toEqual([[1, IssuanceStatus.not_delivered, IssuanceStatus.assigned], [2, IssuanceStatus.not_delivered, IssuanceStatus.assigned]]);

        //a delivered issuance in the selection: 409 as before and not one row more
        await ds.getRepository(Issuance).update(c.id, { status: IssuanceStatus.delivered });
        const total = await rowCount();
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id, c.id], courier_id: f.otherCourier.id })).status).toBe(409);
        expect(await rowCount()).toBe(total);
    });

    it('a PATCH of fields writes nothing, self pickup writes one row, the handover and a delete write theirs', async () => {
        const f = await fixture();
        expect((await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { priority: Priority.urgent, notes: 'note' })).status).toBe(200);
        expect(await rowCount()).toBe(0);
        expect((await post('/api/issuances/mark-urgent', f.managerToken, { ids: [f.issuance.id] })).status).toBe(201);
        expect(await rowCount()).toBe(0);

        expect((await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { self_pickup: true, delivery_date: '2026-11-01' })).status).toBe(200);
        let rows = await rowsOf(f.issuance.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ sequence: 1, previous_status: IssuanceStatus.assigned, new_status: IssuanceStatus.self_pickup, trigger: AuditAction.issuance_self_pickup });
        expect(rows[0].payload.issuance).toMatchObject({ self_pickup: true, revision: 2, delivery_date: '2026-11-01', priority: Priority.urgent });
        expect(rows[0].payload.details).toEqual({});

        const handover = await post(`/api/issuances/${f.issuance.id}/self-pickup/report`, f.managerToken, { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: [{ item_id: f.itemIds[0], delivered: true }, { item_id: f.itemIds[1], delivered: false, reason: NonDeliveryReason.nobody_home, reason_details: 'לא היה במחסן' }] });
        expect(handover.status).toBe(201);
        rows = await rowsOf(f.issuance.id);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ sequence: 2, previous_status: IssuanceStatus.self_pickup, new_status: IssuanceStatus.partially_delivered, trigger: AuditAction.issuance_self_pickup_report });
        expect(rows[1].payload.actor).toMatchObject({ user_id: f.manager.id, role: UserRole.manager });
        expect(rows[1].payload.issuance).toMatchObject({ self_pickup: true, revision: 3 });
        const handoverTask = await ds.getRepository(DeliveryTask).findOne({ where: { issuance_id: f.issuance.id, courier_id: IsNull() } });
        expect(rows[1].payload.details).toEqual({ task_id: handoverTask.id, attempt_id: expect.any(Number), items_delivered: 1, items_total: 2 });
        expectNoCustomer(JSON.stringify(rows[1].payload));

        const second = await openIssuance();
        expect((await del(`/api/issuances/${second.id}`, f.managerToken, { reason: 'הוזמן בטעות' })).status).toBe(200);
        const deleted = await rowsOf(second.id);
        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toMatchObject({ sequence: 1, previous_status: IssuanceStatus.unassigned, new_status: IssuanceStatus.deleted, trigger: AuditAction.issuance_delete });
        expect(deleted[0].payload.details).toEqual({ reason: 'הוזמן בטעות' });
        //a refused delete adds nothing
        expect((await del(`/api/issuances/${second.id}`, f.managerToken, { reason: 'x' })).status).toBe(409);
        expect(await rowsOf(second.id)).toHaveLength(1);
    });

    it('a courier report writes one row as the courier, a replay and a refused report write none', async () => {
        const f = await fixture();
        const first = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, report(f));
        expect(first.status).toBe(201);
        const again = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, report(f));
        expect(again.body.replayed).toBe(true);
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, report(f, { operation_id: 'b0d17000-0000-4000-8000-000000000002' }))).status).toBe(409);

        const rows = await rowsOf(f.issuance.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ sequence: 1, previous_status: IssuanceStatus.assigned, new_status: IssuanceStatus.delivered, trigger: AuditAction.delivery_report });
        expect(rows[0].payload.actor).toEqual({ type: AuditActorType.user, user_id: f.courierUser.id, username: 'c', role: UserRole.courier });
        expect(rows[0].payload.issuance).toEqual({ id: f.issuance.id, sap_number: '7000001', number_prefix: "ס'", priority: Priority.normal, delivery_date: '2026-10-20', self_pickup: false, revision: 2 });
        expect(rows[0].payload.details).toEqual({ task_id: f.task.id, attempt_id: first.body.attempt_id, courier_id: f.courier.id, operation_id: OP_A, items_delivered: 2, items_total: 2 });
        expectNoCustomer(JSON.stringify(rows[0].payload));
    });

    it('a transaction that fails after the status write leaves the status, the audit row and the outbox untouched', async () => {
        const f = await fixture();
        const a = await openIssuance();
        const spy = jest.spyOn(outbox, 'record').mockRejectedValueOnce(new Error('outbox insert refused (spec)'));
        try {
            const res = await post('/api/issuances/assign', f.managerToken, { ids: [a.id], courier_id: f.otherCourier.id });
            expect(res.status).toBe(500);
        } finally {
            spy.mockRestore();
        }
        expect((await ds.getRepository(Issuance).findOneBy({ id: a.id })).status).toBe(IssuanceStatus.unassigned);
        expect(await ds.getRepository(DeliveryTask).count({ where: { issuance_id: a.id } })).toBe(0);
        expect(await ds.getRepository(AuditLog).count({ where: { action: AuditAction.issuance_assign } })).toBe(0);
        expect(await rowCount()).toBe(0);
        //the same request after the spy is gone goes through as usual
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id], courier_id: f.otherCourier.id })).status).toBe(201);
        expect(await rowCount()).toBe(1);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('the worker', () => {
    it('never started its timer here, and holds the fake bucket whatever the developer\'s .env says about the backend', () => {
        expect((worker as any).timer).toBeNull();
        expect(app.get(XML_STORAGE)).toBe(storage);
    });

    it('three changes of one issuance become three documents in one tick, in sequence order, each with its own statuses and time', async () => {
        const f = await fixture();
        const a = await openIssuance({ number_prefix: "ד'" });
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id], courier_id: f.courier.id, scheduled_date: '2026-10-12' })).status).toBe(201);
        expect((await patch(`/api/issuances/${a.id}`, f.managerToken, { self_pickup: true })).status).toBe(200);
        await ds.getRepository(Issuance).update(a.id, { status: IssuanceStatus.unassigned });
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id], courier_id: f.otherCourier.id })).status).toBe(201);

        const before = await rowsOf(a.id);
        expect(before.map((r) => [r.sequence, r.previous_status, r.new_status])).toEqual([
            [1, IssuanceStatus.unassigned, IssuanceStatus.assigned],
            [2, IssuanceStatus.assigned, IssuanceStatus.self_pickup],
            [3, IssuanceStatus.unassigned, IssuanceStatus.assigned],
        ]);

        const summary = await worker.tick();
        expect(summary).toEqual({ claimed: 3, completed: 3, retried: 0, failed: 0, lost: 0 });
        expect(storage.puts).toBe(3);

        const after = await rowsOf(a.id);
        const keys = [...storage.objects.keys()];
        expect(keys).toHaveLength(3);

        //a worker that lost its lease and finishes late: its fail() and complete() carry the attempts of its claim and
        //the fence refuses them, the completed row stays as it is
        expect(await outbox.fail(after[0], 'late', false, 20)).toBeNull();
        expect(await outbox.complete({ id: after[0].id, attempts: 0 }, 'late-key', 'h')).toBe(false);
        expect(await outbox.renew({ id: after[0].id, attempts: 1 }, 60000)).toBe(false);
        expect((await rowsOf(a.id))[0]).toMatchObject({ status: XmlOutboxStatus.completed, attempts: 1, last_error: null, s3_key: after[0].s3_key, lease_until: null });
        for (const [i, r] of after.entries()) {
            expect(r).toMatchObject({ status: XmlOutboxStatus.completed, attempts: 1, lease_until: null, last_error: null });
            expect(r.processed_at).toBeInstanceOf(Date);
            expect(r.s3_key).toBe(objectKey('issuance-status-changes/', r));
            expect(r.s3_key).toMatch(new RegExp(`^issuance-status-changes/\\d{4}/\\d{2}/\\d{2}/issuance_${a.id}_${r.id}\\.xml$`));
            expect(keys[i]).toBe(r.s3_key); //uploaded in sequence order
            const object = storage.objects.get(r.s3_key);
            expect(object.metadata).toEqual({ 'event-id': r.id, 'issuance-id': String(a.id), sequence: String(r.sequence), 'content-sha256': r.content_sha256 });
            expect(object.body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
            expect(object.body).toContain('schemaVersion="0.1-provisional"');
            expect(object.body).toContain(`<EventId>${r.id}</EventId>`);
            expect(object.body).toContain(`<Sequence>${r.sequence}</Sequence>`);
            expect(object.body).toContain(`<OccurredAt>${r.occurred_at.toISOString()}</OccurredAt>`);
            expect(object.body).toContain(`<PreviousStatus>${r.previous_status}</PreviousStatus>`);
            expect(object.body).toContain(`<NewStatus>${r.new_status}</NewStatus>`);
            expect(object.body).toContain(`<Trigger>${r.trigger}</Trigger>`);
            expect(object.body).toContain("<NumberPrefix>ד&apos;</NumberPrefix>");
            expect(object.body).toContain(`<Actor type="user">`);
            expect(object.body).toContain(`<UserId>${f.manager.id}</UserId>`);
            expectNoCustomer(object.body);
        }
        expect(storage.objects.get(after[0].s3_key).body).toContain(`<CourierId>${f.courier.id}</CourierId>`);
        expect(storage.objects.get(after[0].s3_key).body).toContain('<ScheduledDate>2026-10-12</ScheduledDate>');
        expect(storage.objects.get(after[1].s3_key).body).toContain('<SelfPickup>true</SelfPickup>');
        expect(storage.objects.get(after[1].s3_key).body).toContain('<Details/>');

        //a second tick finds nothing, and nothing is uploaded twice
        expect(await worker.tick()).toEqual({ claimed: 0, completed: 0, retried: 0, failed: 0, lost: 0 });
        expect(storage.puts).toBe(3);
    });

    it('a transient failure sends the row back with a backoff and a counted attempt; the third tick completes it with one object', async () => {
        const f = await fixture();
        const a = await openIssuance();
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id], courier_id: f.courier.id })).status).toBe(201);
        storage.script = ['transient', 'config'];

        expect(await worker.tick()).toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0, lost: 0 });
        let [row] = await rowsOf(a.id);
        expect(row).toMatchObject({ status: XmlOutboxStatus.pending, attempts: 1, lease_until: null, last_error: 'transient: ServiceUnavailable: 503' });
        //5s ± 50%: the row is not due yet, a tick right now claims nothing
        expect(row.next_retry_at.getTime()).toBeGreaterThan(Date.now() + 2000);
        expect(row.next_retry_at.getTime()).toBeLessThan(Date.now() + 8000);
        expect(await worker.tick()).toEqual({ claimed: 0, completed: 0, retried: 0, failed: 0, lost: 0 });
        expect((await overview(f.managerToken)).counts).toEqual({ pending: 1, processing: 0, completed: 0, failed: 0, retry_waiting: 1, lease_expired: 0 });

        await retryNow();
        expect(await worker.tick()).toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0, lost: 0 });
        [row] = await rowsOf(a.id);
        expect(row).toMatchObject({ status: XmlOutboxStatus.pending, attempts: 2, last_error: 'config: AccessDenied: 403' });
        expect(row.next_retry_at.getTime()).toBeGreaterThan(Date.now() + 4000); //10s ± 50%

        await retryNow();
        expect(await worker.tick()).toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0, lost: 0 });
        [row] = await rowsOf(a.id);
        expect(row).toMatchObject({ status: XmlOutboxStatus.completed, attempts: 3, last_error: null });
        expect(storage.objects.size).toBe(1);
        expect(storage.puts).toBe(3);
    });

    it('out of attempts the row is failed and stays; a manager retries it and it leaves on the next tick', async () => {
        const f = await fixture();
        const a = await openIssuance();
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id], courier_id: f.courier.id })).status).toBe(201);
        const previous = process.env.XML_EXPORT_MAX_ATTEMPTS;
        process.env.XML_EXPORT_MAX_ATTEMPTS = '2';
        try {
            storage.script = ['transient', 'transient'];
            expect(await worker.tick()).toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0, lost: 0 });
            await retryNow();
            expect(await worker.tick()).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1, lost: 0 });
            let [row] = await rowsOf(a.id);
            expect(row).toMatchObject({ status: XmlOutboxStatus.failed, attempts: 2, lease_until: null, last_error: 'transient: ServiceUnavailable: 503' });
            //failed is not claimed, whatever the retry time says
            await ds.query(`UPDATE xml_outbox SET next_retry_at = now() - interval '1 second'`);
            expect(await worker.tick()).toEqual({ claimed: 0, completed: 0, retried: 0, failed: 0, lost: 0 });

            const seen = await overview(f.managerToken);
            expect(seen.counts).toEqual({ pending: 0, processing: 0, completed: 0, failed: 1, retry_waiting: 0, lease_expired: 0 });
            expect(seen.failed).toHaveLength(1);
            expect(seen.failed[0]).toMatchObject({ id: row.id, issuance_id: a.id, sequence: 1, previous_status: IssuanceStatus.unassigned, new_status: IssuanceStatus.assigned, trigger: AuditAction.issuance_assign, status: XmlOutboxStatus.failed, attempts: 2, lease_until: null, processed_at: null, s3_key: null, content_sha256: null, last_error: 'transient: ServiceUnavailable: 503' });
            expect(Object.keys(seen.failed[0]).sort()).toEqual(['attempts', 'content_sha256', 'created_at', 'id', 'issuance_id', 'last_error', 'lease_until', 'new_status', 'next_retry_at', 'occurred_at', 'previous_status', 'processed_at', 's3_key', 'sequence', 'status', 'trigger']);
            expect(isNaN(Date.parse(seen.failed[0].occurred_at))).toBe(false);

            //a row with more claims than the limit allows (the limit was lowered) is failed at the claim, no upload
            await ds.query(`UPDATE xml_outbox SET status = '${XmlOutboxStatus.pending}', attempts = 5, next_retry_at = now() - interval '1 second'`);
            expect(await worker.tick()).toEqual({ claimed: 1, completed: 0, retried: 0, failed: 1, lost: 0 });
            [row] = await rowsOf(a.id);
            expect(row.last_error).toBe('attempts: 6 claims, the limit is 2');
            expect(storage.puts).toBe(2);

            //two managers clicking together: the row lock lets one through, the other meets the pending row and its 409
            const [r1, r2] = await Promise.all([post(`/api/xml-export/${row.id}/retry`, f.managerToken, {}), post(`/api/xml-export/${row.id}/retry`, f.managerToken, {})]);
            expect([r1.status, r2.status].sort()).toEqual([201, 409]);
            const retried = r1.status === 201 ? r1 : r2;
            expect((r1.status === 201 ? r2 : r1).body.code).toBe('not_failed');
            expect(retried.body).toMatchObject({ id: row.id, status: XmlOutboxStatus.pending, attempts: 0, last_error: null, lease_until: null });
            //the worker that held the failed row before the retry cannot complete it now: its attempts number is gone
            expect(await outbox.complete({ id: row.id, attempts: 6 }, 'stale-key', 'h')).toBe(false);
            expect((await rowsOf(a.id))[0]).toMatchObject({ status: XmlOutboxStatus.pending, attempts: 0, s3_key: null });
            const audit = await ds.getRepository(AuditLog).find({ where: { action: AuditAction.xml_export_retry } });
            expect(audit).toHaveLength(1);
            expect(audit[0]).toMatchObject({ actor_user_id: f.manager.id, actor_role: UserRole.manager, entity_type: 'issuance', entity_id: a.id, issuance_id: a.id, details: { event_id: row.id, sequence: 1, previous_attempts: 6, last_error: 'attempts: 6 claims, the limit is 2' } });

            //only a failed row is retried: a pending one is a 409, a stranger a 404, a non uuid a 400
            expect((await post(`/api/xml-export/${row.id}/retry`, f.managerToken, {})).status).toBe(409);
            expect((await post(`/api/xml-export/${row.id}/retry`, f.managerToken, {})).body.code).toBe('not_failed');
            expect((await post('/api/xml-export/a0d17000-0000-4000-8000-0000000000ff/retry', f.managerToken, {})).status).toBe(404);
            expect((await post('/api/xml-export/12/retry', f.managerToken, {})).status).toBe(400);
            expect(await ds.getRepository(AuditLog).count({ where: { action: AuditAction.xml_export_retry } })).toBe(1);

            expect(await worker.tick()).toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0, lost: 0 });
            [row] = await rowsOf(a.id);
            expect(row).toMatchObject({ status: XmlOutboxStatus.completed, attempts: 1 });
            expect(storage.objects.size).toBe(1);
        } finally {
            if (previous === undefined) delete process.env.XML_EXPORT_MAX_ATTEMPTS;
            else process.env.XML_EXPORT_MAX_ATTEMPTS = previous;
        }
    });

    it('a row whose document cannot be built is failed at once, and the later rows of its issuance are not held back', async () => {
        const f = await fixture();
        const a = await openIssuance();
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id], courier_id: f.courier.id })).status).toBe(201);
        expect((await del(`/api/issuances/${a.id}`, f.managerToken, { reason: 'x' })).status).toBe(200);
        const [first] = await rowsOf(a.id);
        await ds.query(`UPDATE xml_outbox SET payload = payload - 'issuance' WHERE id = $1`, [first.id]);

        //the corrupt first row blocks the second only while it is pending: one claim fails it, the next round of the same
        //tick takes the second
        expect(await worker.tick()).toEqual({ claimed: 2, completed: 1, retried: 0, failed: 1, lost: 0 });
        const rows = await rowsOf(a.id);
        expect(rows[0]).toMatchObject({ status: XmlOutboxStatus.failed, attempts: 1, last_error: 'xml: payload.issuance is missing' });
        expect(rows[1]).toMatchObject({ status: XmlOutboxStatus.completed, sequence: 2 });
        expect(storage.puts).toBe(1);
    });

    it('an upload whose response was lost is reconciled: the second put meets its own object, the head matches, no second file', async () => {
        const f = await fixture();
        const a = await openIssuance();
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id], courier_id: f.courier.id })).status).toBe(201);
        storage.script = ['store_then_timeout'];

        expect(await worker.tick()).toEqual({ claimed: 1, completed: 0, retried: 1, failed: 0, lost: 0 });
        let [row] = await rowsOf(a.id);
        expect(row).toMatchObject({ status: XmlOutboxStatus.pending, attempts: 1, last_error: 'transient: TimeoutError: response lost' });
        expect(storage.objects.size).toBe(1);

        await retryNow();
        expect(await worker.tick()).toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0, lost: 0 });
        [row] = await rowsOf(a.id);
        expect(row).toMatchObject({ status: XmlOutboxStatus.completed, attempts: 2, last_error: null });
        expect(storage.puts).toBe(2);
        expect(storage.heads).toBe(1);
        expect(storage.objects.size).toBe(1);
        expect(storage.objects.get(row.s3_key).metadata['content-sha256']).toBe(row.content_sha256);
    });

    it('a process that died after the upload leaves a processing row; after its lease it is reclaimed and completed, and a foreign object under the key is a failure', async () => {
        const f = await fixture();
        const a = await openIssuance();
        const b = await openIssuance();
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [a.id, b.id], courier_id: f.courier.id })).status).toBe(201);

        //the claim of a worker that is gone: both rows processing, the first one's object already in the bucket, the
        //second one's key taken by something else
        const claimed = await outbox.claim(10, 60000);
        expect(claimed).toHaveLength(2);
        const rowA = claimed.find((r) => r.issuance_id === a.id);
        const rowB = claimed.find((r) => r.issuance_id === b.id);
        const keyA = objectKey('issuance-status-changes/', rowA);
        storage.objects.set(keyA, { body: '<earlier upload/>', metadata: { 'event-id': rowA.id, 'issuance-id': String(a.id), sequence: '1', 'content-sha256': 'to be compared' } });
        storage.objects.set(objectKey('issuance-status-changes/', rowB), { body: '<someone else/>', metadata: { 'event-id': 'another-event', 'content-sha256': 'x' } });

        //within the lease nothing is reclaimed
        expect(await worker.tick()).toEqual({ claimed: 0, completed: 0, retried: 0, failed: 0, lost: 0 });
        expect((await overview(f.managerToken)).counts).toEqual({ pending: 0, processing: 2, completed: 0, failed: 0, retry_waiting: 0, lease_expired: 0 });

        await ds.query(`UPDATE xml_outbox SET lease_until = now() - interval '1 second'`);
        expect((await overview(f.managerToken)).counts.lease_expired).toBe(2);
        //the hash the earlier upload stored must be the one this build gives, so the stored metadata is patched to the
        //real value first: the spec cannot know the sha before the worker built the document
        const built = app.get(XmlBuilderService).build(rowA);
        storage.objects.get(keyA).metadata['content-sha256'] = built.sha256;

        expect(await worker.tick()).toEqual({ claimed: 2, completed: 1, retried: 0, failed: 1, lost: 0 });
        const doneA = (await rowsOf(a.id))[0];
        expect(doneA).toMatchObject({ status: XmlOutboxStatus.completed, attempts: 2, s3_key: keyA, content_sha256: built.sha256, lease_until: null });
        expect(storage.objects.get(keyA).body).toBe('<earlier upload/>'); //not uploaded again
        const failedB = (await rowsOf(b.id))[0];
        expect(failedB.status).toBe(XmlOutboxStatus.failed);
        expect(failedB.last_error).toMatch(/^key_collision: issuance-status-changes\/.+ holds event another-event sha256 x$/);
        expect(storage.puts).toBe(2);
        expect(storage.heads).toBe(2);
    });

    it('two claims at once take disjoint rows, and the later sequence of an issuance waits for the earlier one', async () => {
        const f = await fixture();
        const ids: number[] = [];
        for (let i = 0; i < 10; i++) ids.push((await openIssuance()).id);
        expect((await post('/api/issuances/assign', f.managerToken, { ids, courier_id: f.courier.id })).status).toBe(201);
        //a second change of the first issuance: its sequence 2 must wait for sequence 1
        expect((await del(`/api/issuances/${ids[0]}`, f.managerToken, { reason: 'x' })).status).toBe(200);
        expect(await rowCount()).toBe(11);

        const [one, two] = await Promise.all([outbox.claim(5, 60000), outbox.claim(5, 60000)]);
        expect(one).toHaveLength(5);
        expect(two).toHaveLength(5);
        const taken = [...one, ...two].map((r) => r.id);
        expect(new Set(taken).size).toBe(10);
        for (const r of [...one, ...two]) {
            expect(r.status).toBe(XmlOutboxStatus.processing);
            expect(r.attempts).toBe(1);
            expect(new Date(r.lease_until).getTime()).toBeGreaterThan(Date.now() + 30000);
        }
        //the one row left is sequence 2 of the first issuance, and it is not claimed while sequence 1 is processing
        const left = (await rowsOf()).filter((r) => r.status === XmlOutboxStatus.pending);
        expect(left.map((r) => [r.issuance_id, r.sequence])).toEqual([[ids[0], 2]]);
        expect(await outbox.claim(10, 60000)).toEqual([]);
        //a claimed row within its lease is never claimed again either
        expect(await worker.tick()).toEqual({ claimed: 0, completed: 0, retried: 0, failed: 0, lost: 0 });

        //once sequence 1 is completed by hand, sequence 2 goes
        await outbox.complete(one.concat(two).find((r) => r.issuance_id === ids[0]), 'k', 'h');
        const next = await outbox.claim(10, 60000);
        expect(next.map((r) => [r.issuance_id, r.sequence])).toEqual([[ids[0], 2]]);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('the overview', () => {
    it('lists the failed rows oldest first and at most a hundred of them, the counts stay whole', async () => {
        const f = await fixture();
        await ds.query(`INSERT INTO xml_outbox (id, issuance_id, sequence, previous_status, new_status, trigger, payload, status, attempts, next_retry_at, created_at, occurred_at, last_error)
            SELECT gen_random_uuid(), 1, n, 'unassigned', 'assigned', 'issuance.assign', '{}'::jsonb, 'failed', 20, now(), now() - (n || ' minutes')::interval, now() - (n || ' minutes')::interval, 'transient: 503'
            FROM generate_series(1, 101) AS n`);
        const seen = await overview(f.managerToken);
        expect(seen.counts).toMatchObject({ failed: 101, pending: 0, processing: 0, completed: 0 });
        expect(seen.failed).toHaveLength(100);
        expect(seen.failed[0].sequence).toBe(101); //the oldest created_at
        expect(seen.failed[99].sequence).toBe(2);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('access', () => {
    it('both endpoints are the manager\'s: a courier gets 403, no token 401', async () => {
        const f = await fixture();
        expect((await get('/api/xml-export', f.courierToken)).status).toBe(403);
        expect((await post('/api/xml-export/a0d17000-0000-4000-8000-0000000000ff/retry', f.courierToken, {})).status).toBe(403);
        expect((await request(app.getHttpServer()).get('/api/xml-export')).status).toBe(401);
        expect((await overview(f.managerToken)).counts).toEqual({ pending: 0, processing: 0, completed: 0, failed: 0, retry_waiting: 0, lease_expired: 0 });
    });
});
