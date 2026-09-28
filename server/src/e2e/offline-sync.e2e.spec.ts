import './setup-env';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../app.module';
import { AttemptOutcome, IssuanceStatus, NonDeliveryReason, Priority, RecipientType, ReportConflictCode, TaskStatus, UserRole } from '../../../shared/@core';
import { User, Courier, Issuance, DeliveryTask, DeliveryAttempt, DeliveryOperation } from '../entities';
import { SAMPLE_SIGNATURE } from '../seed/seed.data';

//the report route with operation ids (the offline queue on the tablet) against the same throwaway database as
//hardening.e2e.spec.ts (docker compose up -d first): replay, concurrency, reused ids, the revision token and the
//cancellation paths. the legacy request without an operation id is covered here too so its behaviour stays pinned

let app: INestApplication;
let ds: DataSource;

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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    ds = app.get(DataSource);
});

afterAll(async () => {
    await app?.close();
});

/*──────────────────────────────────────────────────────────────────────────*/

type Fixture = {
    issuance: Issuance;
    task: DeliveryTask;
    courier: Courier;
    courierUser: User;
    otherCourier: Courier;
    otherTask: DeliveryTask;
    managerToken: string;
    courierToken: string;
    otherToken: string;
    itemIds: number[];
    otherItemIds: number[];
};

//ids the tablet would generate. RESTART IDENTITY hands every test the same user ids, so delivery_operations is in the
//truncate list or a literal id here would replay a previous test's attempt
const OP_A = 'a1b2c3d4-0000-4000-8000-000000000001';
const OP_B = 'a1b2c3d4-0000-4000-8000-000000000002';

//a second valid png (magic bytes plus one byte), so the two accounts in the cross account test sign differently
const OTHER_SIGNATURE = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42]).toString('base64');

//one manager, two couriers with a login, each with one assigned issuance. the first issuance has two lines
async function fixture(): Promise<Fixture> {
    await ds.query('TRUNCATE TABLE delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');
    const hash = await bcrypt.hash('1234', 4);

    await ds.getRepository(User).save({ username: 'm', password_hash: hash, display_name: 'manager', role: UserRole.manager });
    const courierUser = await ds.getRepository(User).save({ username: 'c', password_hash: hash, display_name: 'courier', role: UserRole.courier });
    const otherUser = await ds.getRepository(User).save({ username: 'c2', password_hash: hash, display_name: 'courier two', role: UserRole.courier });
    const courier = await ds.getRepository(Courier).save({ name: 'courier one', user_id: courierUser.id });
    const otherCourier = await ds.getRepository(Courier).save({ name: 'courier two', user_id: otherUser.id });

    const issuance = await ds.getRepository(Issuance).save({
        sap_number: '7000001',
        status: IssuanceStatus.assigned,
        customer_name: 'ישראל ישראלי',
        customer_id_number: '012345678',
        customer_phone: '050-1234567',
        address_street: 'הרצל 10',
        address_city: 'תל אביב',
        items: [
            { line_no: 1, product_name: 'מחשב', quantity: 1 },
            { line_no: 2, product_name: 'מקלדת', quantity: 1 },
        ],
    } as any);
    const task = await ds.getRepository(DeliveryTask).save({ issuance_id: issuance.id, courier_id: courier.id, status: TaskStatus.pending });

    const otherIssuance = await ds.getRepository(Issuance).save({
        sap_number: '7000002',
        status: IssuanceStatus.assigned,
        customer_name: 'רוני כהן',
        address_street: 'ביאליק 3',
        address_city: 'חיפה',
        items: [{ line_no: 1, product_name: 'מסך', quantity: 1 }],
    } as any);
    const otherTask = await ds.getRepository(DeliveryTask).save({ issuance_id: otherIssuance.id, courier_id: otherCourier.id, status: TaskStatus.pending });

    const managerToken = (await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'm', password: '1234' })).body.token;
    const courierToken = (await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'c', password: '1234' })).body.token;
    const otherToken = (await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'c2', password: '1234' })).body.token;
    expect(managerToken).toBeTruthy();
    expect(courierToken).toBeTruthy();
    expect(otherToken).toBeTruthy();

    return { issuance, task, courier, courierUser, otherCourier, otherTask, managerToken, courierToken, otherToken, itemIds: issuance.items.map((i) => i.id), otherItemIds: otherIssuance.items.map((i) => i.id) };
}

function post(path: string, token: string, body: any) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

function patch(path: string, token: string, body: any) {
    return request(app.getHttpServer()).patch(path).set('Authorization', `Bearer ${token}`).send(body);
}

function allDelivered(f: Fixture) {
    return { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: f.itemIds.map((item_id) => ({ item_id, delivered: true })) };
}

function noneDelivered(f: Fixture) {
    return { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: f.itemIds.map((item_id) => ({ item_id, delivered: false, reason: NonDeliveryReason.nobody_home, reason_details: 'אין אף אחד' })) };
}

//first line delivered, second not: a partial delivery with a reason to check line by line
function mixed(f: Fixture) {
    return { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: [{ item_id: f.itemIds[0], delivered: true }, { item_id: f.itemIds[1], delivered: false, reason: NonDeliveryReason.customer_refused, reason_details: 'לא רצה' }] };
}

async function state(issuanceId: number) {
    const issuance = await ds.getRepository(Issuance).findOne({ where: { id: issuanceId } });
    const tasks = await ds.getRepository(DeliveryTask).find({ where: { issuance_id: issuanceId }, order: { id: 'ASC' } });
    const attempts = await ds.getRepository(DeliveryAttempt).count();
    const operations = await ds.getRepository(DeliveryOperation).count();
    return { status: issuance.status, tasks: tasks.map((t) => t.status), pending: tasks.filter((t) => t.status === TaskStatus.pending).length, attempts, operations, revision: issuance.revision };
}

async function revisionOf(issuanceId: number) {
    return (await ds.getRepository(Issuance).findOne({ where: { id: issuanceId } })).revision;
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('report with an operation id', () => {
    it('stores the attempt, the receipt and the device time, and bumps the revision', async () => {
        const f = await fixture();
        const sentAt = '2026-09-27T08:15:00.000Z'; //the day before, the tablet was offline
        const res = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...mixed(f), operation_id: OP_A, issuance_revision: 1, client_reported_at: sentAt });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ outcome: AttemptOutcome.partially_delivered, task_id: f.task.id, operation_id: OP_A });
        expect(typeof res.body.attempt_id).toBe('number');
        expect(res.body.replayed).toBeUndefined();

        const attempt = await ds.getRepository(DeliveryAttempt).findOne({ where: { id: res.body.attempt_id }, relations: { items: true }, order: { items: { id: 'ASC' } } });
        expect(attempt.signature_png).toBe(SAMPLE_SIGNATURE);
        expect(attempt.items.map((i) => ({ item_id: i.item_id, delivered: i.delivered, reason: i.reason, reason_details: i.reason_details }))).toEqual([
            { item_id: f.itemIds[0], delivered: true, reason: null, reason_details: null },
            { item_id: f.itemIds[1], delivered: false, reason: NonDeliveryReason.customer_refused, reason_details: 'לא רצה' },
        ]);
        expect(attempt.client_reported_at.toISOString()).toBe(sentAt);
        //reported_at is the server clock, not the value the device sent (a day earlier). the window is wide because the
        //column is a plain timestamp: the docker postgres writes utc and node reads it as local time, a few hours apart
        expect(Math.abs(attempt.reported_at.getTime() - Date.now())).toBeLessThan(12 * 3600_000);
        expect(Math.abs(attempt.reported_at.getTime() - Date.parse(sentAt))).toBeGreaterThan(12 * 3600_000);
        expect(res.body.reported_at).toBe(attempt.reported_at.toISOString());

        const ops = await ds.getRepository(DeliveryOperation).find();
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ user_id: f.courierUser.id, courier_id: f.courier.id, operation_id: OP_A, task_id: f.task.id, attempt_id: res.body.attempt_id });
        expect(ops[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(ops[0].client_reported_at.toISOString()).toBe(sentAt);
        expect(ops[0].result).toEqual(res.body);

        expect(await state(f.issuance.id)).toEqual({ status: IssuanceStatus.partially_delivered, tasks: [TaskStatus.done], pending: 0, attempts: 1, operations: 1, revision: 2 });
    });

    it('a junk client time is stored as null, a bad revision or id is a 400 and writes nothing', async () => {
        const f = await fixture();
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...allDelivered(f), operation_id: OP_A, issuance_revision: '1' })).status).toBe(400);
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...allDelivered(f), operation_id: OP_A, issuance_revision: 1.5 })).status).toBe(400);
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...allDelivered(f), operation_id: 'short' })).status).toBe(400);
        expect(await state(f.issuance.id)).toMatchObject({ pending: 1, attempts: 0, operations: 0, revision: 1 });

        //Date.parse('1') is a real date in v8, the strict parser must not keep it
        const res = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...allDelivered(f), operation_id: OP_A, client_reported_at: '1' });
        expect(res.status).toBe(201);
        const attempt = await ds.getRepository(DeliveryAttempt).findOne({ where: { id: res.body.attempt_id } });
        expect(attempt.client_reported_at).toBeNull();
    });
});

describe('replay', () => {
    it('the same operation id after the task closed returns the first result, nothing is written twice', async () => {
        const f = await fixture();
        const body = { ...allDelivered(f), operation_id: OP_A, issuance_revision: 1 };
        const first = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, body);
        expect(first.status).toBe(201);

        //the tablet never saw the response, restarts and sends the same operation again. the task is closed and the
        //revision moved meanwhile, neither may turn the replay into a 409
        const again = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, body);
        expect(again.status).toBe(201);
        expect(again.body).toEqual({ ...first.body, replayed: true });
        expect(await state(f.issuance.id)).toEqual({ status: IssuanceStatus.delivered, tasks: [TaskStatus.done], pending: 0, attempts: 1, operations: 1, revision: 2 });
    });

    it('two concurrent identical requests: both 201 with the same attempt, exactly one attempt', async () => {
        for (let round = 0; round < 3; round++) {
            const f = await fixture();
            const body = { ...allDelivered(f), operation_id: OP_A };
            const [a, b] = await Promise.all([
                post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, body),
                post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, body),
            ]);
            expect([a.status, b.status]).toEqual([201, 201]);
            expect(a.body.attempt_id).toBe(b.body.attempt_id);
            expect([a.body.replayed, b.body.replayed].filter(Boolean).length).toBeLessThanOrEqual(1);
            expect(await state(f.issuance.id)).toEqual({ status: IssuanceStatus.delivered, tasks: [TaskStatus.done], pending: 0, attempts: 1, operations: 1, revision: 2 });
        }
    });

    it('the same operation id with different content is refused', async () => {
        const f = await fixture();
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...allDelivered(f), operation_id: OP_A })).status).toBe(201);

        const reused = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...noneDelivered(f), operation_id: OP_A });
        expect(reused.status).toBe(409);
        expect(reused.body).toEqual({ statusCode: 409, message: 'operation id was already used with different content', code: ReportConflictCode.operation_reused });
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.delivered, attempts: 1, operations: 1 });
    });

    it('a second report with its own operation id on a closed task is still a conflict', async () => {
        const f = await fixture();
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...allDelivered(f), operation_id: OP_A })).status).toBe(201);

        const second = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...allDelivered(f), operation_id: OP_B });
        expect(second.status).toBe(409);
        expect(second.body.code).toBe(ReportConflictCode.task_closed);
        expect(second.body.statusCode).toBe(409);
        expect(await state(f.issuance.id)).toMatchObject({ attempts: 1, operations: 1 });

        //and when the two different operations race, one wins
        const g = await fixture();
        const [a, b] = await Promise.all([
            post(`/api/delivery/tasks/${g.task.id}/attempts`, g.courierToken, { ...allDelivered(g), operation_id: OP_A }),
            post(`/api/delivery/tasks/${g.task.id}/attempts`, g.courierToken, { ...allDelivered(g), operation_id: OP_B }),
        ]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        expect(await state(g.issuance.id)).toEqual({ status: IssuanceStatus.delivered, tasks: [TaskStatus.done], pending: 0, attempts: 1, operations: 1, revision: 2 });
    });
});

describe('revision token', () => {
    //no real flow reaches this today (every bump also cancels or closes the task), so the stale number is fabricated
    it('a stale issuance_revision is a 409 that writes nothing, the current one goes through', async () => {
        const f = await fixture();
        const stale = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...allDelivered(f), operation_id: OP_A, issuance_revision: 7 });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe(ReportConflictCode.revision_changed);
        expect(await state(f.issuance.id)).toEqual({ status: IssuanceStatus.assigned, tasks: [TaskStatus.pending], pending: 1, attempts: 0, operations: 0, revision: 1 });

        const ok = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...allDelivered(f), operation_id: OP_A, issuance_revision: 1 });
        expect(ok.status).toBe(201);
        expect(await revisionOf(f.issuance.id)).toBe(2);
    });

    it('assign bumps it, priority / date / notes edits and mark urgent do not', async () => {
        const f = await fixture();
        expect((await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { priority: Priority.urgent })).status).toBe(200);
        expect((await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { delivery_date: '2026-10-01' })).status).toBe(200);
        expect((await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { notes: 'הערה' })).status).toBe(200);
        expect((await post('/api/issuances/mark-urgent', f.managerToken, { ids: [f.issuance.id] })).status).toBe(201);
        expect(await revisionOf(f.issuance.id)).toBe(1);

        expect((await post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.otherCourier.id })).status).toBe(201);
        expect(await revisionOf(f.issuance.id)).toBe(2);

        //a fresh unassigned one starts at 1 and moves on its first assignment
        const open = await ds.getRepository(Issuance).save({ sap_number: '7000003', status: IssuanceStatus.unassigned, customer_name: 'x', address_street: 'y', address_city: 'z' } as any);
        expect(await revisionOf(open.id)).toBe(1);
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [open.id], courier_id: f.otherCourier.id })).status).toBe(201);
        expect(await revisionOf(open.id)).toBe(2);
    });
});

describe('a report on a task that was cancelled meanwhile', () => {
    async function expectCancelled(f: Fixture) {
        const res = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...allDelivered(f), operation_id: OP_A, issuance_revision: 1 });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe(ReportConflictCode.task_cancelled);
        expect(await ds.getRepository(DeliveryAttempt).count()).toBe(0);
        expect(await ds.getRepository(DeliveryOperation).count()).toBe(0);
        expect(await revisionOf(f.issuance.id)).toBe(2);
    }

    it('reassigned to another courier', async () => {
        const f = await fixture();
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.otherCourier.id })).status).toBe(201);
        await expectCancelled(f);
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.assigned, tasks: [TaskStatus.cancelled, TaskStatus.pending] });
    });

    //the manager moved the date by assigning again: a new task for the same courier, the old one cancelled. the queued
    //report is not moved to the new task on purpose (no retargeting), the courier gets the conflict and reports again
    it('reassigned to the same courier', async () => {
        const f = await fixture();
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.courier.id, scheduled_date: '2026-10-01' })).status).toBe(201);
        await expectCancelled(f);
        const tasks = await ds.getRepository(DeliveryTask).find({ where: { issuance_id: f.issuance.id }, order: { id: 'ASC' } });
        expect(tasks.map((t) => [t.status, t.courier_id])).toEqual([[TaskStatus.cancelled, f.courier.id], [TaskStatus.pending, f.courier.id]]);
    });

    it('moved to self pickup', async () => {
        const f = await fixture();
        expect((await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { self_pickup: true })).status).toBe(200);
        await expectCancelled(f);
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.self_pickup, tasks: [TaskStatus.cancelled] });
    });

    it('deleted', async () => {
        const f = await fixture();
        const del = await request(app.getHttpServer()).delete(`/api/issuances/${f.issuance.id}`).set('Authorization', `Bearer ${f.managerToken}`).send({ reason: 'בוטל' });
        expect(del.status).toBe(200);
        await expectCancelled(f);
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.deleted, tasks: [TaskStatus.cancelled] });
    });
});

describe('operation ids are per account', () => {
    it('another courier using the same id gets its own result and never the first one', async () => {
        const f = await fixture();
        const a = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, { ...allDelivered(f), operation_id: OP_A });
        expect(a.status).toBe(201);

        //courier two, same operation id, on its own task: a fresh report, not a replay of courier one
        const bBody = { recipient_type: RecipientType.other, recipient_name: 'שכן', recipient_id_number: '300123456', recipient_phone: '054-0000000', signature_png: OTHER_SIGNATURE, items: f.otherItemIds.map((item_id) => ({ item_id, delivered: true })), operation_id: OP_A };
        const b = await post(`/api/delivery/tasks/${f.otherTask.id}/attempts`, f.otherToken, bBody);
        expect(b.status).toBe(201);
        expect(b.body.replayed).toBeUndefined();
        expect(b.body.attempt_id).not.toBe(a.body.attempt_id);
        expect(b.body.task_id).toBe(f.otherTask.id);

        const bAttempt = await ds.getRepository(DeliveryAttempt).findOne({ where: { id: b.body.attempt_id } });
        expect(bAttempt).toMatchObject({ task_id: f.otherTask.id, recipient_name: 'שכן', signature_png: OTHER_SIGNATURE });

        //courier two on courier one's task, with courier one's id: not their task, no stored result, no signature
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.otherToken, { ...allDelivered(f), operation_id: OP_A })).status).toBe(404);
        expect((await request(app.getHttpServer()).get(`/api/delivery/tasks/${f.task.id}`).set('Authorization', `Bearer ${f.otherToken}`)).status).toBe(404);

        const ops = await ds.getRepository(DeliveryOperation).find({ order: { id: 'ASC' } });
        expect(ops.map((o) => [o.user_id, o.operation_id, o.attempt_id])).toEqual([[f.courierUser.id, OP_A, a.body.attempt_id], [f.courierUser.id + 1, OP_A, b.body.attempt_id]]);
        expect(await ds.getRepository(DeliveryAttempt).count()).toBe(2);
    });
});

describe('legacy request without an operation id', () => {
    it('behaves as before: 201 with the result, then 409 task already closed, no receipt row', async () => {
        const f = await fixture();
        const res = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, allDelivered(f));
        expect(res.status).toBe(201);
        expect(res.body).toEqual({ attempt_id: expect.any(Number), outcome: AttemptOutcome.delivered, task_id: f.task.id, reported_at: expect.any(String) });
        expect(res.body.operation_id).toBeUndefined();

        const again = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, allDelivered(f));
        expect(again.status).toBe(409);
        expect(again.body).toEqual({ statusCode: 409, message: 'task already closed', code: ReportConflictCode.task_closed });
        expect(await state(f.issuance.id)).toEqual({ status: IssuanceStatus.delivered, tasks: [TaskStatus.done], pending: 0, attempts: 1, operations: 0, revision: 2 });
    });
});

describe('identity', () => {
    it('login and me return id next to sub', async () => {
        const f = await fixture();
        const login = await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'c', password: '1234' });
        expect(login.body.user).toMatchObject({ id: f.courierUser.id, sub: f.courierUser.id, courier_id: f.courier.id });

        const me = await request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${f.courierToken}`);
        expect(me.status).toBe(200);
        expect(me.body).toMatchObject({ id: f.courierUser.id, sub: f.courierUser.id, courier_id: f.courier.id });
    });
});
