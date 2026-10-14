import './setup-env';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../app.module';
import { ConflictReviewStatus, IssuanceStatus, NonDeliveryReason, RecipientType, ReportConflictCode, TaskStatus, UserRole } from '../../../shared/@core';
import { User, Courier, Issuance, DeliveryTask, DeliveryAttempt, DeliveryConflict, DeliveryOperation } from '../entities';
import { SAMPLE_SIGNATURE } from '../seed/seed.data';

//rejected reports kept as evidence (delivery_conflicts) against the same throwaway database as the other e2e specs:
//the courier's upload after a 409, its idempotency, what it must never do to the delivery, and the manager's review

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

type Fixture = { issuance: Issuance; task: DeliveryTask; courier: Courier; courierUser: User; otherCourier: Courier; managerToken: string; manager2Token: string; courierToken: string; otherToken: string; itemIds: number[] };

const OP_A = 'c0ff11ce-0000-4000-8000-000000000001';
const OP_B = 'c0ff11ce-0000-4000-8000-000000000002';

//two managers, two couriers with a login, one issuance with two lines assigned to the first courier
async function fixture(): Promise<Fixture> {
    await ds.query('TRUNCATE TABLE xml_outbox, audit_log, delivery_conflicts, delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');
    const hash = await bcrypt.hash('1234', 4);

    await ds.getRepository(User).save({ username: 'm', password_hash: hash, display_name: 'דנה', role: UserRole.manager });
    await ds.getRepository(User).save({ username: 'm2', password_hash: hash, display_name: 'אסף', role: UserRole.manager });
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

    const login = async (username: string) => (await request(app.getHttpServer()).post('/api/auth/login').send({ username, password: '1234' })).body.token;
    const f = { issuance, task, courier, courierUser, otherCourier, managerToken: await login('m'), manager2Token: await login('m2'), courierToken: await login('c'), otherToken: await login('c2'), itemIds: issuance.items.map((i) => i.id) };
    expect(f.managerToken && f.manager2Token && f.courierToken && f.otherToken).toBeTruthy();
    return f;
}

function post(path: string, token: string, body: any) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

function get(path: string, token: string) {
    return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
}

//the report the tablet signed while offline: everything delivered, against revision 1
function report(f: Fixture, extra: any = {}) {
    return { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: f.itemIds.map((item_id) => ({ item_id, delivered: true })), operation_id: OP_A, issuance_revision: 1, client_reported_at: '2026-09-29T08:00:00.000Z', ...extra };
}

//nothing delivered, a different content under the same id when needed
function otherReport(f: Fixture, extra: any = {}) {
    return { ...report(f), items: f.itemIds.map((item_id) => ({ item_id, delivered: false, reason: NonDeliveryReason.nobody_home, reason_details: 'אין אף אחד' })), ...extra };
}

//the manager sends courier two before the tablet comes back: the old task is cancelled, the report is stale
async function reassign(f: Fixture) {
    expect((await post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.otherCourier.id })).status).toBe(201);
}

async function deliveryState(issuanceId: number) {
    const issuance = await ds.getRepository(Issuance).findOne({ where: { id: issuanceId } });
    const tasks = await ds.getRepository(DeliveryTask).find({ where: { issuance_id: issuanceId }, order: { id: 'ASC' } });
    return { status: issuance.status, revision: issuance.revision, tasks: tasks.map((t) => t.status), attempts: await ds.getRepository(DeliveryAttempt).count(), operations: await ds.getRepository(DeliveryOperation).count(), conflicts: await ds.getRepository(DeliveryConflict).count() };
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('keeping a rejected report', () => {
    it('a stale report is refused by the attempts route, then kept exactly once with the state of that moment, and the delivery is untouched', async () => {
        const f = await fixture();
        await reassign(f);
        const before = await deliveryState(f.issuance.id);
        expect(before).toMatchObject({ status: IssuanceStatus.assigned, revision: 2, tasks: [TaskStatus.cancelled, TaskStatus.pending], attempts: 0, conflicts: 0 });

        const rejected = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, report(f));
        expect(rejected.status).toBe(409);
        expect(rejected.body.code).toBe(ReportConflictCode.task_cancelled);

        const kept = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f));
        expect(kept.status).toBe(201);
        expect(kept.body).toMatchObject({ kind: 'conflict_recorded', operation_id: OP_A, task_id: f.task.id, review_status: ConflictReviewStatus.pending, reviewed_at: null });
        expect(kept.body.replayed).toBeUndefined();
        expect(typeof kept.body.conflict_id).toBe('number');

        const row = await ds.getRepository(DeliveryConflict).findOne({ where: { id: kept.body.conflict_id } });
        expect(row).toMatchObject({ user_id: f.courierUser.id, courier_id: f.courier.id, task_id: f.task.id, issuance_id: f.issuance.id, submitted_revision: 1, rejection_code: ReportConflictCode.task_cancelled, signature_png: SAMPLE_SIGNATURE, recipient_name: 'ישראל ישראלי', review_status: ConflictReviewStatus.pending, review_version: 0 });
        expect(row.items).toEqual(f.itemIds.map((item_id) => ({ item_id, delivered: true, reason: null, reason_details: null })));
        expect(row.client_reported_at.toISOString()).toBe('2026-09-29T08:00:00.000Z');
        expect(row.observed).toEqual({ task_status: TaskStatus.cancelled, issuance_status: IssuanceStatus.assigned, issuance_revision: 2, current_task_id: f.task.id + 1, current_courier_id: f.otherCourier.id, attempt_id: null });

        //no attempt, no close, no status, no revision bump, no success receipt
        expect(await deliveryState(f.issuance.id)).toEqual({ ...before, conflicts: 1 });

        //the lost response case: the same upload again is the same receipt, and a restart of the tablet sends it a third time
        for (let i = 0; i < 2; i++) {
            const again = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f));
            expect(again.status).toBe(201);
            expect(again.body).toEqual({ ...kept.body, replayed: true });
        }
        expect(await deliveryState(f.issuance.id)).toEqual({ ...before, conflicts: 1 });
    });

    it('two concurrent uploads of the same evidence keep one row, and a reused id with other content is refused', async () => {
        const f = await fixture();
        await reassign(f);
        const [a, b] = await Promise.all([
            post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f)),
            post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f)),
        ]);
        expect([a.status, b.status]).toEqual([201, 201]);
        expect(a.body.conflict_id).toBe(b.body.conflict_id);
        expect((await deliveryState(f.issuance.id)).conflicts).toBe(1);

        const reused = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, otherReport(f));
        expect(reused.status).toBe(409);
        expect(reused.body.code).toBe(ReportConflictCode.operation_reused);
        expect((await deliveryState(f.issuance.id)).conflicts).toBe(1);
    });

    it('a report that was applied is answered with its delivery result, never stored as a conflict', async () => {
        const f = await fixture();
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, report(f))).status).toBe(201);

        //the tablet lost the 201, a manager reassigned the not yet visible delivery... the task is closed, the tablet
        //believes the later 409 and uploads evidence: the server knows better
        const res = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f));
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ kind: 'delivered', outcome: 'delivered', task_id: f.task.id, operation_id: OP_A, replayed: true });
        expect(typeof res.body.attempt_id).toBe('number');
        expect(await deliveryState(f.issuance.id)).toMatchObject({ status: IssuanceStatus.delivered, attempts: 1, operations: 1, conflicts: 0 });

        //and a different content under the applied operation's id is refused, not stored
        expect((await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, otherReport(f))).body.code).toBe(ReportConflictCode.operation_reused);
        expect((await deliveryState(f.issuance.id)).conflicts).toBe(0);
    });

    it('a rejected report that delivered nothing is kept without a recipient and a signature', async () => {
        const f = await fixture();
        await reassign(f);
        const bare = { items: otherReport(f).items, operation_id: OP_A, issuance_revision: 1, client_reported_at: '2026-09-29T08:00:00.000Z' };
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, bare)).status).toBe(409);

        const kept = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, bare);
        expect(kept.status).toBe(201);
        expect(kept.body.kind).toBe('conflict_recorded');
        const row = await ds.getRepository(DeliveryConflict).findOne({ where: { id: kept.body.conflict_id } });
        expect(row).toMatchObject({ recipient_type: null, recipient_name: null, recipient_id_number: null, recipient_phone: null, signature_png: null, rejection_code: ReportConflictCode.task_cancelled });
        expect(row.items.every((i) => i.delivered === false)).toBe(true);

        //the same bare body again is the replay, not a reused id: the hash is stable with the nulls
        const again = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, bare);
        expect(again.status).toBe(201);
        expect(again.body).toMatchObject({ conflict_id: kept.body.conflict_id, replayed: true });

        //a partial report without a signature is still refused here too
        const partial = { ...bare, operation_id: OP_B, items: [{ item_id: f.itemIds[0], delivered: true }, { item_id: f.itemIds[1], delivered: false, reason: NonDeliveryReason.nobody_home, reason_details: 'x' }] };
        expect((await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, partial)).status).toBe(400);

        const detail = await get(`/api/conflicts/${kept.body.conflict_id}`, f.managerToken);
        expect(detail.status).toBe(200);
        expect(detail.body.conflict).toMatchObject({ recipient_type: null, signature_png: null });
        expect((await deliveryState(f.issuance.id)).conflicts).toBe(1);
    });

    it('a report that could still be applied is not evidence of anything', async () => {
        const f = await fixture();
        const res = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f));
        expect(res.status).toBe(409);
        expect(res.body.code).toBe(ReportConflictCode.not_a_conflict);
        expect(await deliveryState(f.issuance.id)).toMatchObject({ tasks: [TaskStatus.pending], attempts: 0, conflicts: 0 });
    });

    it('malformed input, another account and a missing operation id never become review records', async () => {
        const f = await fixture();
        await reassign(f);
        const bad = [
            { ...report(f), signature_png: 'data:image/png;base64,not base64!!' },
            { ...report(f), items: [] },
            { ...report(f), items: [{ item_id: f.itemIds[0], delivered: 'yes' }] },
            { ...report(f), items: [{ item_id: f.itemIds[0], delivered: false, reason: 'dog', reason_details: 'x' }] },
            { ...report(f), recipient_type: RecipientType.other, recipient_name: '' },
            { ...report(f), operation_id: undefined },
            { ...report(f), operation_id: 'short' },
            { ...report(f), issuance_revision: '1' },
        ];
        for (const body of bad) expect((await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, body)).status).toBe(400);

        //courier two owns neither the task nor the operation id
        expect((await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.otherToken, report(f))).status).toBe(404);
        expect((await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.managerToken, report(f))).status).toBe(403);
        expect((await request(app.getHttpServer()).post(`/api/delivery/tasks/${f.task.id}/conflicts`).send(report(f))).status).toBe(401);
        expect((await deliveryState(f.issuance.id)).conflicts).toBe(0);

        //answers for lines the issuance no longer has are still kept: they are what was signed
        const stale = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f, { items: [{ item_id: 999, delivered: true }] }));
        expect(stale.status).toBe(201);
        expect((await ds.getRepository(DeliveryConflict).findOne({ where: { id: stale.body.conflict_id } })).items).toEqual([{ item_id: 999, delivered: true, reason: null, reason_details: null }]);
    });

    it('the other rejection reasons are recorded with their code', async () => {
        //another device (a second operation) reported the task: task_closed, with that attempt in the observed state
        let f = await fixture();
        const applied = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, otherReport(f, { operation_id: OP_B }));
        expect(applied.status).toBe(201);
        let kept = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f));
        expect(kept.status).toBe(201);
        let row = await ds.getRepository(DeliveryConflict).findOne({ where: { id: kept.body.conflict_id } });
        expect(row.rejection_code).toBe(ReportConflictCode.task_closed);
        expect(row.observed).toMatchObject({ task_status: TaskStatus.done, issuance_status: IssuanceStatus.not_delivered, attempt_id: applied.body.attempt_id, current_task_id: null });
        expect(await deliveryState(f.issuance.id)).toMatchObject({ status: IssuanceStatus.not_delivered, attempts: 1, conflicts: 1 });

        //self pickup: task_cancelled, no open task
        f = await fixture();
        expect((await request(app.getHttpServer()).patch(`/api/issuances/${f.issuance.id}`).set('Authorization', `Bearer ${f.managerToken}`).send({ self_pickup: true })).status).toBe(200);
        kept = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f));
        row = await ds.getRepository(DeliveryConflict).findOne({ where: { id: kept.body.conflict_id } });
        expect(row.rejection_code).toBe(ReportConflictCode.task_cancelled);
        expect(row.observed).toMatchObject({ issuance_status: IssuanceStatus.self_pickup, current_task_id: null });
        expect(await deliveryState(f.issuance.id)).toMatchObject({ status: IssuanceStatus.self_pickup, tasks: [TaskStatus.cancelled], attempts: 0 });

        //a fabricated stale revision on an open task: revision_changed
        f = await fixture();
        kept = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f, { issuance_revision: 9 }));
        expect(kept.status).toBe(201);
        row = await ds.getRepository(DeliveryConflict).findOne({ where: { id: kept.body.conflict_id } });
        expect(row).toMatchObject({ rejection_code: ReportConflictCode.revision_changed, submitted_revision: 9 });
        expect(await deliveryState(f.issuance.id)).toMatchObject({ status: IssuanceStatus.assigned, revision: 1, tasks: [TaskStatus.pending], attempts: 0 });
    });
});

describe('the courier reads their own review status', () => {
    it('returns only the caller\'s rows, by operation id', async () => {
        const f = await fixture();
        await reassign(f);
        const kept = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f));
        expect(kept.status).toBe(201);

        const mine = await get(`/api/delivery/conflicts?operation_ids=${OP_A},${OP_B}`, f.courierToken);
        expect(mine.status).toBe(200);
        expect(mine.body).toEqual([{ operation_id: OP_A, conflict_id: kept.body.conflict_id, received_at: kept.body.received_at, review_status: ConflictReviewStatus.pending, reviewed_at: null }]);

        expect((await get(`/api/delivery/conflicts?operation_ids=${OP_A}`, f.otherToken)).body).toEqual([]);
        expect((await get('/api/delivery/conflicts', f.courierToken)).body).toEqual([]);
        expect((await get(`/api/delivery/conflicts?operation_ids=${OP_A}`, f.managerToken)).status).toBe(403);
    });
});

describe('manager review', () => {
    async function keptConflict(f: Fixture) {
        await reassign(f);
        const kept = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f));
        expect(kept.status).toBe(201);
        return kept.body.conflict_id as number;
    }

    it('lists without signatures, opens with the signature next to the current state, and marks reviewed with a note', async () => {
        const f = await fixture();
        const id = await keptConflict(f);

        const list = await get('/api/conflicts?status=pending', f.managerToken);
        expect(list.status).toBe(200);
        expect(list.body).toMatchObject({ total: 1, page: 1, page_size: 20 });
        expect(list.body.rows[0]).toMatchObject({ id, operation_id: OP_A, rejection_code: ReportConflictCode.task_cancelled, review_status: ConflictReviewStatus.pending, courier: { id: f.courier.id, name: 'courier one' }, issuance: { sap_number: '7000001', status: IssuanceStatus.assigned, revision: 2 } });
        expect(list.body.rows[0].signature_png).toBeUndefined();
        expect(list.body.rows[0].items).toBeUndefined();
        expect((await get('/api/conflicts?status=reviewed', f.managerToken)).body.total).toBe(0);

        const detail = await get(`/api/conflicts/${id}`, f.managerToken);
        expect(detail.status).toBe(200);
        expect(detail.body.conflict).toMatchObject({ id, signature_png: SAMPLE_SIGNATURE, submitted_revision: 1, observed: { task_status: TaskStatus.cancelled, issuance_revision: 2 } });
        expect(detail.body.conflict.items).toEqual(f.itemIds.map((item_id) => ({ item_id, delivered: true, reason: null, reason_details: null })));
        expect(detail.body.conflict.issuance.items.map((i) => i.product_name)).toEqual(['מחשב', 'מקלדת']);
        expect(detail.body.current).toMatchObject({ issuance: { status: IssuanceStatus.assigned, revision: 2 }, attempt: null });
        expect(detail.body.current.tasks.map((t) => [t.status, t.courier_name])).toEqual([[TaskStatus.cancelled, 'courier one'], [TaskStatus.pending, 'courier two']]);

        //the review: a note is required, the version must be the loaded one, the row and the delivery stay as they were
        expect((await post(`/api/conflicts/${id}/review`, f.managerToken, { note: '  ', version: 0 })).status).toBe(400);
        expect((await post(`/api/conflicts/${id}/review`, f.managerToken, { note: 'x', version: '0' })).status).toBe(400);
        const before = await deliveryState(f.issuance.id);
        const reviewed = await post(`/api/conflicts/${id}/review`, f.managerToken, { note: 'דיברתי עם המשנע, ההנפקה נמסרה במשימה החדשה', version: 0 });
        expect(reviewed.status).toBe(201);
        expect(reviewed.body).toMatchObject({ id, review_status: ConflictReviewStatus.reviewed, review_note: 'דיברתי עם המשנע, ההנפקה נמסרה במשימה החדשה', reviewed_by_name: 'דנה', review_version: 1 });
        expect(reviewed.body.reviewed_at).toBeTruthy();
        expect(await deliveryState(f.issuance.id)).toEqual(before);
        const row = await ds.getRepository(DeliveryConflict).findOne({ where: { id } });
        expect(row).toMatchObject({ signature_png: SAMPLE_SIGNATURE, rejection_code: ReportConflictCode.task_cancelled, submitted_revision: 1 });
        expect(row.items).toEqual(f.itemIds.map((item_id) => ({ item_id, delivered: true, reason: null, reason_details: null })));

        //the same manager sending the same note again (a lost response) is fine; the pending list is empty now
        expect((await post(`/api/conflicts/${id}/review`, f.managerToken, { note: 'דיברתי עם המשנע, ההנפקה נמסרה במשימה החדשה', version: 0 })).status).toBe(201);
        expect((await get('/api/conflicts?status=pending', f.managerToken)).body.total).toBe(0);
        expect((await get('/api/conflicts?status=reviewed', f.managerToken)).body.rows[0]).toMatchObject({ id, reviewed_by_name: 'דנה' });

        //the courier sees the status on the next sync, not the note
        const mine = await get(`/api/delivery/conflicts?operation_ids=${OP_A}`, f.courierToken);
        expect(mine.body[0]).toMatchObject({ conflict_id: id, review_status: ConflictReviewStatus.reviewed });
        expect(mine.body[0].reviewed_at).toBeTruthy();
        expect(mine.body[0].review_note).toBeUndefined();
    });

    it('two managers: the second one gets the first one\'s review back instead of overwriting it, and a stale version is refused', async () => {
        const f = await fixture();
        const id = await keptConflict(f);

        const [a, b] = await Promise.all([
            post(`/api/conflicts/${id}/review`, f.managerToken, { note: 'הערה של דנה', version: 0 }),
            post(`/api/conflicts/${id}/review`, f.manager2Token, { note: 'הערה של אסף', version: 0 }),
        ]);
        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([201, 409]);
        const loser = a.status === 409 ? a : b;
        const winner = a.status === 201 ? a : b;
        expect(loser.body.code).toBe('review_conflict');
        expect(loser.body.review).toMatchObject({ review_status: ConflictReviewStatus.reviewed, review_note: winner.body.review_note, reviewed_by_name: winner.body.reviewed_by_name, review_version: 1 });
        expect((await ds.getRepository(DeliveryConflict).findOne({ where: { id } })).review_note).toBe(winner.body.review_note);

        //a screen that loaded version 0 long ago cannot write over version 1 either
        const stale = await post(`/api/conflicts/${id}/review`, f.manager2Token, { note: 'שוב', version: 0 });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe('review_conflict');

        //the courier cannot use any of the manager routes
        expect((await get('/api/conflicts', f.courierToken)).status).toBe(403);
        expect((await get(`/api/conflicts/${id}`, f.courierToken)).status).toBe(403);
        expect((await post(`/api/conflicts/${id}/review`, f.courierToken, { note: 'x', version: 1 })).status).toBe(403);
    });
});
