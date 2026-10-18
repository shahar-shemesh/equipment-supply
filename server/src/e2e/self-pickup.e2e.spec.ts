import './setup-env';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../app.module';
import { tokenFor } from './auth-helper';
import { AuditAction, AuditActorType, IssuanceStatus, NonDeliveryReason, RecipientType, TaskStatus, UserRole } from '../../../shared/@core';
import { User, Courier, Issuance, DeliveryTask, DeliveryAttempt, AuditLog } from '../entities';
import { COURIER_NAME_SQL } from '../issuances/issuances.service';
import { SAMPLE_SIGNATURE } from '../seed/seed.data';

//the self pickup handover (docs/plans/self-pickup-handover.md): the manager moves an issuance to self pickup, nobody is
//shown as its courier, and POST /api/issuances/:id/self-pickup/report records the handover at the warehouse with the
//manager where the courier would be. same throwaway database as the other e2e specs, wiped before every test

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

type Fixture = { issuance: Issuance; task: DeliveryTask; manager: User; courier: Courier; managerToken: string; courierToken: string; itemIds: number[] };

//one manager (a hebrew display name, so it cannot be confused with a courier row), one courier with a login, one
//issuance with two lines assigned to that courier
async function fixture(): Promise<Fixture> {
    await ds.query('TRUNCATE TABLE xml_outbox, audit_log, delivery_conflicts, delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');

    const manager = await ds.getRepository(User).save({ username: 'm', display_name: 'דנה המחסנאית', role: UserRole.manager });
    const courierUser = await ds.getRepository(User).save({ username: 'c', display_name: 'courier', role: UserRole.courier });
    const courier = await ds.getRepository(Courier).save({ name: 'courier one', user_id: courierUser.id });

    const issuance = await ds.getRepository(Issuance).save({
        sap_number: '7000001',
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
    const f = { issuance, task, manager, courier, managerToken: await login('m'), courierToken: await login('c'), itemIds: issuance.items.map((i) => i.id) };
    expect(f.managerToken && f.courierToken).toBeTruthy();
    return f;
}

function post(path: string, token: string, body: any) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

function patch(path: string, token: string, body: any) {
    return request(app.getHttpServer()).patch(path).set('Authorization', `Bearer ${token}`).send(body);
}

function get(path: string, token: string) {
    return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
}

function handover(f: Fixture, body: any) {
    return post(`/api/issuances/${f.issuance.id}/self-pickup/report`, f.managerToken, body);
}

async function toSelfPickup(f: Fixture) {
    const res = await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { self_pickup: true });
    expect(res.status).toBe(200);
    return res.body;
}

function allDelivered(f: Fixture) {
    return { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: f.itemIds.map((item_id) => ({ item_id, delivered: true })) };
}

function noneDelivered(f: Fixture) {
    return { items: f.itemIds.map((item_id) => ({ item_id, delivered: false, reason: NonDeliveryReason.customer_refused, reason_details: 'לא הגיע לאסוף' })) };
}

function partial(f: Fixture) {
    return { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: [{ item_id: f.itemIds[0], delivered: true }, { item_id: f.itemIds[1], delivered: false, reason: NonDeliveryReason.other, reason_details: 'חסר במלאי' }] };
}

async function state(issuanceId: number) {
    const issuance = await ds.getRepository(Issuance).findOne({ where: { id: issuanceId } });
    const tasks = await ds.getRepository(DeliveryTask).find({ where: { issuance_id: issuanceId }, order: { id: 'ASC' } });
    const attempts = await ds.getRepository(DeliveryAttempt).count();
    return { status: issuance.status, self_pickup: issuance.self_pickup, revision: issuance.revision, delivered_by_user_id: issuance.delivered_by_user_id, tasks: tasks.map((t) => t.status), attempts };
}

async function boardRow(f: Fixture, id = f.issuance.id) {
    const res = await get('/api/issuances?page_size=100', f.managerToken);
    expect(res.status).toBe(200);
    return res.body.rows.find((r) => r.id === id);
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('moving to self pickup', () => {
    it('an assigned issuance: the task is cancelled, nobody is its courier, nobody delivered it', async () => {
        const f = await fixture();
        const body = await toSelfPickup(f);
        expect(body).toMatchObject({ status: IssuanceStatus.self_pickup, self_pickup: true, current_task: null, delivered_by_user_id: null, delivered_by_name: null });
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.self_pickup, tasks: [TaskStatus.cancelled], delivered_by_user_id: null, attempts: 0 });
        expect(await boardRow(f)).toMatchObject({ current_task: null, delivered_by_name: null });
    });

    it('a not delivered issuance: the done task stays as history but is not current any more, the sort key is null', async () => {
        const f = await fixture();
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, noneDelivered(f))).status).toBe(201);
        //before the move the board still shows the courier of the closed task
        expect((await boardRow(f)).current_task.courier.name).toBe('courier one');

        await toSelfPickup(f);
        const detail = await get(`/api/issuances/${f.issuance.id}`, f.managerToken);
        expect(detail.body).toMatchObject({ status: IssuanceStatus.self_pickup, current_task: null, delivered_by_user_id: null });
        expect(detail.body.tasks.map((t) => t.status)).toEqual([TaskStatus.done]);
        expect(await boardRow(f)).toMatchObject({ current_task: null, delivered_by_name: null });

        const [row] = await ds.query(`SELECT ${COURIER_NAME_SQL} AS courier_name FROM issuances i WHERE i.id = $1`, [f.issuance.id]);
        expect(row.courier_name).toBeNull();
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('the handover at the warehouse', () => {
    it('everything delivered: the issuance is delivered, still self pickup, and the manager is its deliverer', async () => {
        const f = await fixture();
        await toSelfPickup(f);
        const res = await handover(f, allDelivered(f));
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ id: f.issuance.id, status: IssuanceStatus.delivered, self_pickup: true, delivered_by_user_id: f.manager.id, delivered_by_name: 'דנה המחסנאית', revision: 3 });
        expect(res.body.delivered_by).toBeUndefined(); //the users row never leaves the server
        expect(res.body.current_task).toMatchObject({ status: TaskStatus.done, courier_id: null, assigned_by: f.manager.id, scheduled_date: '2026-10-20' });
        expect(res.body.current_task.courier).toBeNull();
        expect(res.body.current_task.attempts).toHaveLength(1);
        expect(res.body.current_task.attempts[0]).toMatchObject({ outcome: IssuanceStatus.delivered, recipient_type: RecipientType.customer, recipient_name: 'ישראל ישראלי', signature_png: SAMPLE_SIGNATURE });
        expect(res.body.current_task.attempts[0].items.map((i) => [i.item_id, i.delivered])).toEqual(f.itemIds.map((id) => [id, true]));

        expect(await state(f.issuance.id)).toEqual({ status: IssuanceStatus.delivered, self_pickup: true, revision: 3, delivered_by_user_id: f.manager.id, tasks: [TaskStatus.cancelled, TaskStatus.done], attempts: 1 });
        //the board shows the manager where the courier would be
        expect(await boardRow(f)).toMatchObject({ status: IssuanceStatus.delivered, delivered_by_name: 'דנה המחסנאית', current_task: { courier_id: null, courier: null } });
    });

    it('nothing delivered: not delivered, no recipient and no signature, the manager still recorded', async () => {
        const f = await fixture();
        await toSelfPickup(f);
        const res = await handover(f, noneDelivered(f));
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ status: IssuanceStatus.not_delivered, self_pickup: true, delivered_by_user_id: f.manager.id, delivered_by_name: 'דנה המחסנאית' });
        const attempt = await ds.getRepository(DeliveryAttempt).findOne({ where: { id: res.body.current_task.attempts[0].id } });
        expect(attempt).toMatchObject({ outcome: IssuanceStatus.not_delivered, recipient_type: null, recipient_name: null, recipient_id_number: null, recipient_phone: null, signature_png: null, client_reported_at: null });
    });

    it('partial: partially delivered, self pickup kept', async () => {
        const f = await fixture();
        await toSelfPickup(f);
        const res = await handover(f, partial(f));
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ status: IssuanceStatus.partially_delivered, self_pickup: true, delivered_by_user_id: f.manager.id });
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.partially_delivered, self_pickup: true, attempts: 1 });
    });

    it('the audit row names the manager as the actor and carries the ids and counts', async () => {
        const f = await fixture();
        await toSelfPickup(f);
        const res = await handover(f, partial(f));
        expect(res.status).toBe(201);
        const rows = await ds.getRepository(AuditLog).find({ where: { action: AuditAction.issuance_self_pickup_report } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            actor_type: AuditActorType.user,
            actor_user_id: f.manager.id,
            actor_username: 'm',
            actor_role: UserRole.manager,
            entity_type: 'issuance',
            entity_id: f.issuance.id,
            issuance_id: f.issuance.id,
            details: { task_id: res.body.current_task.id, attempt_id: res.body.current_task.attempts[0].id, outcome: IssuanceStatus.partially_delivered, items_delivered: 1, items_total: 2, revision: 3 },
        });
        //and the manager can read it back through the audit route
        const page = await get(`/api/audit?action=${AuditAction.issuance_self_pickup_report}`, f.managerToken);
        expect(page.status).toBe(200);
        expect(page.body.items).toHaveLength(1);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('refused handovers write nothing', () => {
    it('a wrong state is a 409 naming the issuance and its status: assigned, delivered, deleted, or a second report', async () => {
        const f = await fixture();
        const assigned = await handover(f, allDelivered(f));
        expect(assigned.status).toBe(409);
        expect(assigned.body.message).toBe('issuance 7000001 is assigned, self_pickup_report is not allowed');
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.assigned, tasks: [TaskStatus.pending], attempts: 0, delivered_by_user_id: null });

        await toSelfPickup(f);
        expect((await handover(f, allDelivered(f))).status).toBe(201);
        const twice = await handover(f, allDelivered(f));
        expect(twice.status).toBe(409);
        expect(twice.body.message).toContain('7000001 is delivered');
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.delivered, tasks: [TaskStatus.cancelled, TaskStatus.done], attempts: 1 });

        const g = await fixture();
        await toSelfPickup(g);
        expect((await request(app.getHttpServer()).delete(`/api/issuances/${g.issuance.id}`).set('Authorization', `Bearer ${g.managerToken}`).send({ reason: 'x' })).status).toBe(200);
        const deleted = await handover(g, allDelivered(g));
        expect(deleted.status).toBe(409);
        expect(deleted.body.message).toContain('is deleted');
        expect(await state(g.issuance.id)).toMatchObject({ status: IssuanceStatus.deleted, attempts: 0 });
    });

    it('a courier token is a 403', async () => {
        const f = await fixture();
        await toSelfPickup(f);
        const res = await post(`/api/issuances/${f.issuance.id}/self-pickup/report`, f.courierToken, allDelivered(f));
        expect(res.status).toBe(403);
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.self_pickup, tasks: [TaskStatus.cancelled], attempts: 0 });
    });

    it('a malformed body is a 400 from the shared validators', async () => {
        const f = await fixture();
        await toSelfPickup(f);
        const stringDelivered = await handover(f, { ...allDelivered(f), items: [{ item_id: f.itemIds[0], delivered: 'true' }, { item_id: f.itemIds[1], delivered: true }] });
        expect(stringDelivered.status).toBe(400);
        expect(stringDelivered.body.message).toContain('delivered must be true or false');
        const duplicate = await handover(f, { ...allDelivered(f), items: [{ item_id: f.itemIds[0], delivered: true }, { item_id: f.itemIds[0], delivered: true }] });
        expect(duplicate.status).toBe(400);
        expect(duplicate.body.message).toContain('duplicate answer');
        const noSignature = await handover(f, { ...allDelivered(f), signature_png: '' });
        expect(noSignature.status).toBe(400);
        expect(noSignature.body.message).toContain('signature_png');
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.self_pickup, tasks: [TaskStatus.cancelled], attempts: 0, delivered_by_user_id: null, revision: 2 });
        expect(await ds.getRepository(AuditLog).count({ where: { action: AuditAction.issuance_self_pickup_report } })).toBe(0);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('the courier side', () => {
    it('a courier report is what it was: the courier shown, nobody recorded as the deliverer', async () => {
        const f = await fixture();
        const res = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, allDelivered(f));
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ outcome: IssuanceStatus.delivered, task_id: f.task.id });
        expect(await state(f.issuance.id)).toEqual({ status: IssuanceStatus.delivered, self_pickup: false, revision: 2, delivered_by_user_id: null, tasks: [TaskStatus.done], attempts: 1 });
        expect(await boardRow(f)).toMatchObject({ delivered_by_name: null, current_task: { courier: { name: 'courier one' } } });
    });

    it('after a courier left it not delivered: the handover wins over the closed courier task, in the column and in the sort key', async () => {
        const f = await fixture();
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, noneDelivered(f))).status).toBe(201);
        await toSelfPickup(f);
        expect((await handover(f, allDelivered(f))).status).toBe(201);

        //the newest task is the handover, with no courier: the LEFT JOIN keeps it and the manager's name takes the place
        const row = await boardRow(f);
        expect(row).toMatchObject({ status: IssuanceStatus.delivered, self_pickup: true, delivered_by_name: 'דנה המחסנאית' });
        expect(row.current_task.courier).toBeNull();
        expect(row.current_task.id).not.toBe(f.task.id);
        const [sql] = await ds.query(`SELECT ${COURIER_NAME_SQL} AS courier_name FROM issuances i WHERE i.id = $1`, [f.issuance.id]);
        expect(sql.courier_name).toBe('דנה המחסנאית');
    });

    it('a handover that collected nothing: self pickup again shows nobody, and a courier delivery after it is never attributed to the manager', async () => {
        const f = await fixture();
        await toSelfPickup(f);
        expect((await handover(f, noneDelivered(f))).status).toBe(201);
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.not_delivered, delivered_by_user_id: f.manager.id });

        //waiting again: the switch clears the record, nothing is shown, the sort key is null
        await toSelfPickup(f);
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.self_pickup, delivered_by_user_id: null });
        expect(await boardRow(f)).toMatchObject({ current_task: null, delivered_by_name: null });
        const [sql] = await ds.query(`SELECT ${COURIER_NAME_SQL} AS courier_name FROM issuances i WHERE i.id = $1`, [f.issuance.id]);
        expect(sql.courier_name).toBeNull();

        //a second handover that collected nothing, then a courier takes the issuance from not_delivered and delivers it
        expect((await handover(f, noneDelivered(f))).status).toBe(201);
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.not_delivered, delivered_by_user_id: f.manager.id });
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.courier.id })).status).toBe(201);
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.assigned, self_pickup: false, delivered_by_user_id: null });
        const open = await ds.getRepository(DeliveryTask).findOne({ where: { issuance_id: f.issuance.id, status: TaskStatus.pending } });
        expect((await post(`/api/delivery/tasks/${open.id}/attempts`, f.courierToken, allDelivered(f))).status).toBe(201);
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.delivered, self_pickup: false, delivered_by_user_id: null });
        expect(await boardRow(f)).toMatchObject({ delivered_by_name: null, current_task: { courier: { name: 'courier one' } } });
    });

    it('the handover task is never listed for any courier', async () => {
        const f = await fixture();
        await toSelfPickup(f);
        expect((await handover(f, allDelivered(f))).status).toBe(201);
        for (const tab of ['all', 'pending', 'done']) {
            const res = await get(`/api/delivery/tasks?tab=${tab}`, f.courierToken);
            expect(res.status).toBe(200);
            expect(res.body.rows).toEqual([]);
        }
        expect((await get('/api/delivery/tasks', f.courierToken)).body.counts).toEqual({ all: 0, pending: 0, done: 0 });
        //nor by its id or by the printed number
        const handoverTask = await ds.getRepository(DeliveryTask).findOne({ where: { issuance_id: f.issuance.id, status: TaskStatus.done } });
        expect((await get(`/api/delivery/tasks/${handoverTask.id}`, f.courierToken)).status).toBe(404);
        expect((await get('/api/delivery/lookup?number=7000001', f.courierToken)).status).toBe(403);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('the board sorted by courier', () => {
    it('places the manager name where the same sql does, the waiting self pickup with the unassigned', async () => {
        const f = await fixture();
        //a second courier delivery, a handover, a waiting self pickup and an unassigned row next to the fixture's assigned one
        const more = await ds.getRepository(Issuance).save([
            { sap_number: '7000002', status: IssuanceStatus.unassigned, customer_name: 'a', address_street: 'y', address_city: 'z', items: [{ line_no: 1, product_name: 'x', quantity: 1 }] },
            { sap_number: '7000003', status: IssuanceStatus.unassigned, customer_name: 'b', address_street: 'y', address_city: 'z', items: [{ line_no: 1, product_name: 'x', quantity: 1 }] },
            { sap_number: '7000004', status: IssuanceStatus.unassigned, customer_name: 'c', address_street: 'y', address_city: 'z', items: [{ line_no: 1, product_name: 'x', quantity: 1 }] },
        ] as any);
        const [handedOver, waiting] = more;
        for (const row of [handedOver, waiting]) expect((await patch(`/api/issuances/${row.id}`, f.managerToken, { self_pickup: true })).status).toBe(200);
        const res = await post(`/api/issuances/${handedOver.id}/self-pickup/report`, f.managerToken, { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: [{ item_id: handedOver.items[0].id, delivered: true }] });
        expect(res.status).toBe(201);

        for (const order of ['asc', 'desc']) {
            const expected = (await ds.query(`SELECT i.id FROM issuances i WHERE i.deleted_at IS NULL ORDER BY ${COURIER_NAME_SQL} ${order.toUpperCase()} NULLS LAST, i.id ASC`)).map((r) => +r.id);
            const page = await get(`/api/issuances?sort=courier&order=${order}&page_size=100`, f.managerToken);
            expect(page.status).toBe(200);
            expect(page.body.rows.map((r) => r.id)).toEqual(expected);
            //the two named rows come first in some order, the waiting self pickup and the unassigned rows after them
            const names = page.body.rows.map((r) => r.current_task?.courier?.name || r.delivered_by_name || null);
            expect(names.slice(0, 2).sort()).toEqual(['courier one', 'דנה המחסנאית']);
            expect(names.slice(2)).toEqual([null, null]);
        }
    });
});
