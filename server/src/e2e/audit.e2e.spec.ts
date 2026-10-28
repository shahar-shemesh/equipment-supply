import './setup-env';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../app.module';
import { tokenFor } from './auth-helper';
import { AttemptOutcome, AuditAction, AuditActorType, AuditEntityType, IAuditEntry, IAuditPage, IssuanceStatus, Priority, RecipientType, ReportConflictCode, TaskStatus, UserRole } from '../../../shared/@core';
import { User, Courier, Issuance, DeliveryTask, AuditLog } from '../entities';
import { SAMPLE_SIGNATURE, couriers as seedCouriers, users as seedUsers } from '../seed/seed.data';
import { SeedService } from '../seed/seed.service';

//the audit log against the same throwaway database as the other e2e specs: every action of the matrix in
//docs/plans/audit-log.md, read back through GET /api/audit. the rows of a request are asserted next to its response, so
//"a rolled back request leaves no row" is checked on the real routes and not on the service alone

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

type Fixture = { issuance: Issuance; task: DeliveryTask; manager: User; courierUser: User; courier: Courier; otherCourier: Courier; managerToken: string; courierToken: string; itemIds: number[] };

const OP_A = 'a0d17000-0000-4000-8000-000000000001';

//one manager, one courier with a login, one courier without, one issuance with two lines assigned to the first courier.
//the two logins at the end are the first two rows of every test
async function fixture(): Promise<Fixture> {
    await ds.query('TRUNCATE TABLE xml_import_files, xml_outbox, audit_log, delivery_conflicts, delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');

    const manager = await ds.getRepository(User).save({ username: 'm', display_name: 'דנה', role: UserRole.manager });
    const courierUser = await ds.getRepository(User).save({ username: 'c', display_name: 'courier', role: UserRole.courier });
    const courier = await ds.getRepository(Courier).save({ name: 'courier one', user_id: courierUser.id });
    const otherCourier = await ds.getRepository(Courier).save({ name: 'courier two' });

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

async function audit(token: string, query = ''): Promise<IAuditPage> {
    const res = await get(`/api/audit${query ? `?${query}` : ''}`, token);
    expect(res.status).toBe(200);
    return res.body;
}

async function rowsOf(token: string, action: AuditAction) {
    return (await audit(token, `action=${action}&size=100`)).items;
}

async function openIssuance(extra: any = {}) {
    return ds.getRepository(Issuance).save({ sap_number: `70000${10 + (await ds.getRepository(Issuance).count())}`, status: IssuanceStatus.unassigned, customer_name: 'x', address_street: 'y', address_city: 'z', ...extra } as any);
}

//the report the tablet signed: everything delivered, against revision 1
function report(f: Fixture) {
    return { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: f.itemIds.map((item_id) => ({ item_id, delivered: true })), operation_id: OP_A, issuance_revision: 1, client_reported_at: '2026-09-29T08:00:00.000Z' };
}

//what every row that reaches the api has to satisfy: no signature anywhere in details, no string longer than the cap
function expectClean(items: IAuditEntry[]) {
    const walk = (v: any) => {
        if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(200);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
            for (const [k, x] of Object.entries(v)) {
                expect(k).not.toBe('signature_png');
                walk(x);
            }
        }
    };
    for (const row of items) walk(row.details);
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('issuance actions', () => {
    it('a bulk assign writes one row per issuance under one batch id, and a batch with a delivered issuance writes nothing', async () => {
        const f = await fixture();
        const a = await openIssuance();
        const b = await openIssuance({ status: IssuanceStatus.not_delivered });

        const res = await post('/api/issuances/assign', f.managerToken, { ids: [b.id, f.issuance.id, a.id], courier_id: f.otherCourier.id, scheduled_date: '2026-10-12' });
        expect(res.status).toBe(201);

        const rows = await rowsOf(f.managerToken, AuditAction.issuance_assign);
        expect(rows).toHaveLength(3);
        expect(new Set(rows.map((r) => r.batch_id)).size).toBe(1);
        expect(rows[0].batch_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(rows.map((r) => r.issuance_id).sort((x, y) => x - y)).toEqual([f.issuance.id, a.id, b.id]);
        for (const r of rows) {
            expect(r).toMatchObject({ actor_type: AuditActorType.user, actor_user_id: f.manager.id, actor_username: 'm', actor_role: UserRole.manager, entity_type: AuditEntityType.issuance, entity_id: r.issuance_id });
            expect(r.details).toMatchObject({ courier_id: f.otherCourier.id, scheduled_date: '2026-10-12' });
        }
        const fromStatus = Object.fromEntries(rows.map((r) => [r.issuance_id, r.details.from_status]));
        expect(fromStatus).toEqual({ [f.issuance.id]: IssuanceStatus.assigned, [a.id]: IssuanceStatus.unassigned, [b.id]: IssuanceStatus.not_delivered });
        //the task ids on the rows are the new open tasks, not the cancelled one
        const open = await ds.getRepository(DeliveryTask).find({ where: { status: TaskStatus.pending } });
        expect(rows.map((r) => r.details.task_id).sort((x, y) => x - y)).toEqual(open.map((t) => t.id).sort((x, y) => x - y));

        //a delivered issuance in the selection: 409 as before and not one row more
        await ds.getRepository(Issuance).update(a.id, { status: IssuanceStatus.delivered });
        const total = (await audit(f.managerToken)).total;
        const refused = await post('/api/issuances/assign', f.managerToken, { ids: [b.id, a.id], courier_id: f.otherCourier.id });
        expect(refused.status).toBe(409);
        expect((await audit(f.managerToken)).total).toBe(total);
        expectClean(rows);
    });

    it('an edit writes the changed fields only, and a repeat of the stored values writes nothing', async () => {
        const f = await fixture();
        const total = (await audit(f.managerToken)).total;

        const same = await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { priority: Priority.normal, delivery_date: null, notes: null });
        expect(same.status).toBe(200);
        expect((await audit(f.managerToken)).total).toBe(total);

        const edit = await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { priority: Priority.urgent, notes: 'עדיף בבוקר' });
        expect(edit.status).toBe(200);
        const rows = await rowsOf(f.managerToken, AuditAction.issuance_edit);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ issuance_id: f.issuance.id, entity_id: f.issuance.id, entity_type: AuditEntityType.issuance, actor_user_id: f.manager.id, batch_id: null });
        expect(rows[0].details).toEqual({ changes: { priority: { from: Priority.normal, to: Priority.urgent }, notes: { from: null, to: 'עדיף בבוקר' } } });

        //a date edit compares days: the same day sent again is not a change
        expect((await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { delivery_date: '2026-10-20' })).status).toBe(200);
        expect((await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { delivery_date: '2026-10-20' })).status).toBe(200);
        const dated = await rowsOf(f.managerToken, AuditAction.issuance_edit);
        expect(dated).toHaveLength(2);
        expect(dated[0].details).toEqual({ changes: { delivery_date: { from: null, to: '2026-10-20' } } });

        //a note may be 500 characters; the row keeps the first 200 of it, the issuance keeps the whole of it
        expect((await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { notes: 'x'.repeat(300) })).status).toBe(200);
        const long = (await rowsOf(f.managerToken, AuditAction.issuance_edit))[0];
        expect(long.details.changes.notes).toEqual({ from: 'עדיף בבוקר', to: 'x'.repeat(200) });
        expect((await get(`/api/issuances/${f.issuance.id}`, f.managerToken)).body.notes).toHaveLength(300);
    });

    it('mark urgent, self pickup and delete each write a row with the state they started from', async () => {
        const f = await fixture();
        //mark urgent over [open urgent, open normal, delivered]: the count stays 2, the row is for the normal one only
        const urgent = await openIssuance({ priority: Priority.urgent });
        const done = await openIssuance({ status: IssuanceStatus.delivered });
        const marked = await post('/api/issuances/mark-urgent', f.managerToken, { ids: [urgent.id, f.issuance.id, done.id] });
        expect(marked.status).toBe(201);
        expect(marked.body).toEqual({ updated: 2 });
        const urgentRows = await rowsOf(f.managerToken, AuditAction.issuance_mark_urgent);
        expect(urgentRows).toHaveLength(1);
        expect(urgentRows[0]).toMatchObject({ issuance_id: f.issuance.id, entity_id: f.issuance.id, actor_user_id: f.manager.id, details: { from_priority: Priority.normal } });
        expect(urgentRows[0].batch_id).toBeTruthy();
        //the same click again: still 2 editable rows, nothing moved, no row
        expect((await post('/api/issuances/mark-urgent', f.managerToken, { ids: [urgent.id, f.issuance.id, done.id] })).body).toEqual({ updated: 2 });
        expect(await rowsOf(f.managerToken, AuditAction.issuance_mark_urgent)).toHaveLength(1);

        const pickup = await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { self_pickup: true });
        expect(pickup.status).toBe(200);
        const pickupRows = await rowsOf(f.managerToken, AuditAction.issuance_self_pickup);
        expect(pickupRows).toHaveLength(1);
        expect(pickupRows[0]).toMatchObject({ issuance_id: f.issuance.id, entity_id: f.issuance.id, actor_user_id: f.manager.id });
        expect(pickupRows[0].details).toEqual({ from_status: IssuanceStatus.assigned });
        expect(await rowsOf(f.managerToken, AuditAction.issuance_edit)).toHaveLength(0);

        //a field edit sent along with the self pickup rides on the same row, it is not a second issuance.edit
        const second = await openIssuance();
        expect((await patch(`/api/issuances/${second.id}`, f.managerToken, { self_pickup: true, priority: Priority.urgent })).status).toBe(200);
        const withEdit = (await rowsOf(f.managerToken, AuditAction.issuance_self_pickup))[0];
        expect(withEdit.issuance_id).toBe(second.id);
        expect(withEdit.details).toEqual({ from_status: IssuanceStatus.unassigned, changes: { priority: { from: Priority.normal, to: Priority.urgent } } });
        expect(await rowsOf(f.managerToken, AuditAction.issuance_edit)).toHaveLength(0);

        const deleted = await del(`/api/issuances/${f.issuance.id}`, f.managerToken, { reason: 'הוזמן בטעות' });
        expect(deleted.status).toBe(200);
        const delRows = await rowsOf(f.managerToken, AuditAction.issuance_delete);
        expect(delRows).toHaveLength(1);
        expect(delRows[0]).toMatchObject({ issuance_id: f.issuance.id, details: { reason: 'הוזמן בטעות', from_status: IssuanceStatus.self_pickup } });

        //a refused delete (already deleted) adds nothing
        const total = (await audit(f.managerToken)).total;
        expect((await del(`/api/issuances/${f.issuance.id}`, f.managerToken, { reason: 'x' })).status).toBe(409);
        expect((await audit(f.managerToken)).total).toBe(total);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('delivery rows', () => {
    it('an accepted report writes one row as the courier, and a replay of the same operation writes none', async () => {
        const f = await fixture();
        const first = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, report(f));
        expect(first.status).toBe(201);
        const again = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, report(f));
        expect(again.status).toBe(201);
        expect(again.body.replayed).toBe(true);

        const rows = await rowsOf(f.managerToken, AuditAction.delivery_report);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor_type: AuditActorType.user, actor_user_id: f.courierUser.id, actor_username: 'c', actor_role: UserRole.courier, entity_type: AuditEntityType.delivery_task, entity_id: f.task.id, issuance_id: f.issuance.id, batch_id: null });
        expect(rows[0].details).toEqual({ task_id: f.task.id, attempt_id: first.body.attempt_id, outcome: AttemptOutcome.delivered, operation_id: OP_A, items_delivered: 2, items_total: 2, revision: 2 });
        expectClean((await audit(f.managerToken, 'size=100')).items);
    });

    it('a report without an operation id (an older tablet build) writes the same row with a null operation id', async () => {
        const f = await fixture();
        const legacy = { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: f.itemIds.map((item_id) => ({ item_id, delivered: true })) };
        const res = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, legacy);
        expect(res.status).toBe(201);
        const rows = await rowsOf(f.managerToken, AuditAction.delivery_report);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor_user_id: f.courierUser.id, entity_id: f.task.id, issuance_id: f.issuance.id });
        expect(rows[0].details).toEqual({ task_id: f.task.id, attempt_id: res.body.attempt_id, outcome: AttemptOutcome.delivered, operation_id: null, items_delivered: 2, items_total: 2, revision: 2 });
    });

    it('a rejected report leaves no row; the evidence kept for the manager and its review write one each', async () => {
        const f = await fixture();
        //the manager moves the delivery to courier two before the tablet comes back: the report is stale
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.otherCourier.id })).status).toBe(201);
        const total = (await audit(f.managerToken)).total;
        const rejected = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, report(f));
        expect(rejected.status).toBe(409);
        expect(rejected.body.code).toBe(ReportConflictCode.task_cancelled);
        expect((await audit(f.managerToken)).total).toBe(total);

        const kept = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f));
        expect(kept.status).toBe(201);
        //the same evidence again is a replay of the receipt, no second row
        expect((await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, report(f))).body.replayed).toBe(true);
        const recorded = await rowsOf(f.managerToken, AuditAction.delivery_conflict_record);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ actor_user_id: f.courierUser.id, entity_type: AuditEntityType.delivery_conflict, entity_id: kept.body.conflict_id, issuance_id: f.issuance.id });
        expect(recorded[0].details).toEqual({ task_id: f.task.id, operation_id: OP_A, rejection_code: ReportConflictCode.task_cancelled, submitted_revision: 1 });

        const review = await post(`/api/conflicts/${kept.body.conflict_id}/review`, f.managerToken, { note: 'נבדק', version: 0 });
        expect(review.status).toBe(201);
        //the same manager sending the same note again is the lost response case, not a second review
        expect((await post(`/api/conflicts/${kept.body.conflict_id}/review`, f.managerToken, { note: 'נבדק', version: 0 })).status).toBe(201);
        const reviewed = await rowsOf(f.managerToken, AuditAction.delivery_conflict_review);
        expect(reviewed).toHaveLength(1);
        expect(reviewed[0]).toMatchObject({ actor_user_id: f.manager.id, entity_type: AuditEntityType.delivery_conflict, entity_id: kept.body.conflict_id, issuance_id: f.issuance.id, details: { review_version: 1 } });

        //the history of the issuance is one query: the assign, the evidence and its review all name it
        const history = await audit(f.managerToken, `issuance_id=${f.issuance.id}`);
        expect(history.items.map((r) => r.action)).toEqual([AuditAction.delivery_conflict_review, AuditAction.delivery_conflict_record, AuditAction.issuance_assign]);
        expectClean((await audit(f.managerToken, 'size=100')).items);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('courier rows', () => {
    it('create, update and remove write theirs, and a deleted courier added again is a reactivation', async () => {
        const f = await fixture();
        const form = { name: 'ישראל ישראלי', id_number: '300786655', phone: '0524438192' };
        const created = await post('/api/couriers', f.managerToken, form);
        expect(created.status).toBe(201);
        const id = created.body.id;
        expect(await rowsOf(f.managerToken, AuditAction.courier_create)).toMatchObject([{ actor_user_id: f.manager.id, entity_type: AuditEntityType.courier, entity_id: id, issuance_id: null, details: { name: 'ישראל ישראלי', employee_id: null } }]);

        //the same form again: 200 and no row. a new phone: one row with that field only
        expect((await patch(`/api/couriers/${id}`, f.managerToken, form)).status).toBe(200);
        expect(await rowsOf(f.managerToken, AuditAction.courier_update)).toHaveLength(0);
        expect((await patch(`/api/couriers/${id}`, f.managerToken, { ...form, phone: '0501234567' })).status).toBe(200);
        const updated = await rowsOf(f.managerToken, AuditAction.courier_update);
        expect(updated).toHaveLength(1);
        expect(updated[0]).toMatchObject({ entity_id: id, details: { changes: { phone: { from: '052-4438192', to: '050-1234567' } } } });

        //a duplicate id number is a 409 and no row
        const total = (await audit(f.managerToken)).total;
        expect((await post('/api/couriers', f.managerToken, { ...form, name: 'אחר' })).status).toBe(409);
        expect((await audit(f.managerToken)).total).toBe(total);

        //two at once: two rows, one batch
        const removed = await post('/api/couriers/remove', f.managerToken, { ids: [id, f.otherCourier.id] });
        expect(removed.status).toBe(201);
        const removedRows = await rowsOf(f.managerToken, AuditAction.courier_remove);
        expect(removedRows).toHaveLength(2);
        expect(new Set(removedRows.map((r) => r.batch_id)).size).toBe(1);
        expect(removedRows.map((r) => r.details.name).sort()).toEqual(['courier two', 'ישראל ישראלי'].sort());
        //the name the screen prints comes from the couriers row by entity_id, inactive rows included: the removed two are
        //still named, and the create row names its courier too
        expect(removedRows.map((r) => r.courier_name).sort()).toEqual(['courier two', 'ישראל ישראלי'].sort());
        expect((await rowsOf(f.managerToken, AuditAction.courier_create))[0]).toMatchObject({ courier_name: 'ישראל ישראלי', issuance_number: null, actor_name: 'דנה' });

        //back under the same id number: a reactivation of the same row, not a second create
        const back = await post('/api/couriers', f.managerToken, { ...form, name: 'ישראל חוזר' });
        expect(back.status).toBe(201);
        expect(back.body.id).toBe(id);
        expect(await rowsOf(f.managerToken, AuditAction.courier_reactivate)).toMatchObject([{ entity_id: id, details: { name: 'ישראל חוזר', employee_id: null } }]);
        expect(await rowsOf(f.managerToken, AuditAction.courier_create)).toHaveLength(1);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('login and reading the log', () => {
    it('a login writes its row with the primary role, a refused mock login writes nothing, and a courier may not read', async () => {
        const f = await fixture();
        //the mock login has no password to get wrong: an unknown identity is a 400 and an identity whose users row the
        //fixture did not insert a 503 (auth.e2e.spec). neither is a credential failure, neither leaves a row
        expect((await request(app.getHttpServer()).post('/api/auth/mock/login').send({ identity: 'admin' })).status).toBe(400);
        expect((await request(app.getHttpServer()).post('/api/auth/mock/login').send({ identity: 'manager' })).status).toBe(503);
        expect(await rowsOf(f.managerToken, AuditAction.auth_login_failed)).toEqual([]);

        const logins = await rowsOf(f.managerToken, AuditAction.auth_login);
        expect(logins.map((r) => r.actor_username).sort()).toEqual(['c', 'm']);
        expect(logins.find((r) => r.actor_username === 'm')).toMatchObject({ actor_type: AuditActorType.user, actor_user_id: f.manager.id, actor_role: UserRole.manager, entity_type: AuditEntityType.user, entity_id: f.manager.id, details: null });

        expect((await get('/api/audit', f.courierToken)).status).toBe(403);
        expect((await request(app.getHttpServer()).get('/api/audit')).status).toBe(401);
    });

    it('filters, paging and the newest first order; a bad filter is a 400, not an empty page', async () => {
        const f = await fixture();
        expect((await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { priority: Priority.urgent })).status).toBe(200);
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.otherCourier.id })).status).toBe(201);

        const all = await audit(f.managerToken);
        expect(all.total).toBe(4); //the two logins of the fixture, the edit, the assign
        expect(all.items.map((r) => r.action)).toEqual([AuditAction.issuance_assign, AuditAction.issuance_edit, AuditAction.auth_login, AuditAction.auth_login]);
        for (let i = 1; i < all.items.length; i++) expect(all.items[i - 1].id).toBeGreaterThan(all.items[i].id);

        const page = await audit(f.managerToken, 'page=2&size=3');
        expect(page.total).toBe(4);
        expect(page.items.map((r) => r.action)).toEqual([AuditAction.auth_login]);

        expect((await audit(f.managerToken, `issuance_id=${f.issuance.id}`)).items.map((r) => r.action)).toEqual([AuditAction.issuance_assign, AuditAction.issuance_edit]);
        expect((await audit(f.managerToken, `actor_user_id=${f.courierUser.id}`)).items.map((r) => r.action)).toEqual([AuditAction.auth_login]);
        expect((await audit(f.managerToken, `action=${AuditAction.issuance_edit}`)).total).toBe(1);
        expect((await audit(f.managerToken, 'issuance_id=999999')).total).toBe(0);

        //from / to around now. the clock values are not asserted, only that the window includes and excludes
        //a day either side, so a run that crosses utc midnight between the fixture and this line still finds its rows
        const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
        expect((await audit(f.managerToken, `from=${day(-1)}&to=${day(1)}`)).total).toBe(4);
        expect((await audit(f.managerToken, 'to=2000-01-01')).total).toBe(0);
        expect((await audit(f.managerToken, 'from=2999-01-01')).total).toBe(0);

        for (const bad of ['size=101', 'size=0', 'page=0', 'action=issuance.explode', 'issuance_id=abc', 'actor_user_id=1x', 'from=yesterday', 'to=2026-13-45', 'order=sideways', `action=${AuditAction.issuance_assign},issuance.explode`, `action=${AuditAction.issuance_assign}&action=${AuditAction.issuance_edit}`, `q=${'x'.repeat(101)}`]) {
            const res = await get(`/api/audit?${bad}`, f.managerToken);
            expect([bad, res.status]).toEqual([bad, 400]);
        }

        const shape = (await audit(f.managerToken, 'size=1')).items[0];
        expect(Object.keys(shape).sort()).toEqual(['action', 'actor_name', 'actor_role', 'actor_type', 'actor_user_id', 'actor_username', 'at', 'batch_id', 'courier_name', 'details', 'entity_id', 'entity_type', 'id', 'issuance_id', 'issuance_number']);
        expect(isNaN(Date.parse(shape.at))).toBe(false);
    });

    //what the audit screen sends: the oldest first order, a list of actions, the text search, and the names it prints
    it('order=asc, a comma list of actions, the text search over the actor and the issuance number, and the resolved names', async () => {
        const f = await fixture();
        expect((await patch(`/api/issuances/${f.issuance.id}`, f.managerToken, { priority: Priority.urgent })).status).toBe(200);
        expect((await post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.otherCourier.id })).status).toBe(201);

        const newest = (await audit(f.managerToken)).items.map((r) => r.id);
        const oldest = await audit(f.managerToken, 'order=asc');
        expect(oldest.items.map((r) => r.id)).toEqual([...newest].reverse());
        expect(oldest.items.map((r) => r.action)).toEqual([AuditAction.auth_login, AuditAction.auth_login, AuditAction.issuance_edit, AuditAction.issuance_assign]);
        expect((await audit(f.managerToken, 'order=desc')).items.map((r) => r.id)).toEqual(newest);

        const two = await audit(f.managerToken, `action=${AuditAction.issuance_assign},${AuditAction.issuance_edit}`);
        expect(two.total).toBe(2);
        expect(two.items.map((r) => r.action)).toEqual([AuditAction.issuance_assign, AuditAction.issuance_edit]);
        expect((await audit(f.managerToken, `action=${AuditAction.issuance_edit},${AuditAction.issuance_edit}`)).total).toBe(1);

        //q: the manager by her display name (every row she wrote, the login included), the courier by his, the issuance
        //by its number, the manager by her username; blank is no filter
        expect((await audit(f.managerToken, `q=${encodeURIComponent('דנה')}`)).items.map((r) => r.action)).toEqual([AuditAction.issuance_assign, AuditAction.issuance_edit, AuditAction.auth_login]);
        expect((await audit(f.managerToken, 'q=courier')).items.map((r) => [r.action, r.actor_username])).toEqual([[AuditAction.auth_login, 'c']]);
        expect((await audit(f.managerToken, 'q=7000001')).items.map((r) => r.action)).toEqual([AuditAction.issuance_assign, AuditAction.issuance_edit]);
        expect((await audit(f.managerToken, 'q=M')).total).toBe(3); //ilike: the username m, whatever the case
        expect((await audit(f.managerToken, 'q=')).total).toBe(4);
        expect((await audit(f.managerToken, 'q=%20%20')).total).toBe(4);
        expect((await audit(f.managerToken, 'q=nobody')).total).toBe(0);
        //q and the other filters are an AND
        expect((await audit(f.managerToken, `q=7000001&action=${AuditAction.issuance_edit}`)).total).toBe(1);

        //the names: the user's current display name, the issuance number, the courier of an assign row from details
        const assign = (await rowsOf(f.managerToken, AuditAction.issuance_assign))[0];
        expect(assign).toMatchObject({ actor_name: 'דנה', issuance_number: '7000001', courier_name: 'courier two' });
        const courierLogin = (await audit(f.managerToken, `actor_user_id=${f.courierUser.id}`)).items[0];
        expect(courierLogin).toMatchObject({ action: AuditAction.auth_login, actor_name: 'courier', issuance_number: null, courier_name: null });

        //the account deleted after the fact: the row keeps the copied username and the search still finds it by that,
        //the display name is gone from the answer and from the search
        await ds.getRepository(User).delete(f.courierUser.id);
        const orphan = (await audit(f.managerToken, `actor_user_id=${f.courierUser.id}`)).items[0];
        expect(orphan).toMatchObject({ actor_user_id: f.courierUser.id, actor_username: 'c', actor_name: null });
        expect((await audit(f.managerToken, 'q=courier')).total).toBe(0);
        expect((await audit(f.managerToken, 'q=c')).items.map((r) => r.actor_username)).toEqual(['c']);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('seed', () => {
    it('the seed ends with one system row that counts what it inserted, and it reads back through the api', async () => {
        //the import etl's tracking table is the seed's to wipe too: a row left behind would make a re-dropped document
        //read as imported already (etls/issuance-xml-import)
        await ds.query(`INSERT INTO xml_import_files (content_sha256, file_name, size_bytes, status) VALUES ('${'a'.repeat(64)}', 'left-behind.xml', 1, 'completed')`);
        const previous = process.env.ALLOW_DESTRUCTIVE_SEED;
        process.env.ALLOW_DESTRUCTIVE_SEED = 'true';
        try {
            await app.get(SeedService).run();
        } finally {
            if (previous === undefined) delete process.env.ALLOW_DESTRUCTIVE_SEED;
            else process.env.ALLOW_DESTRUCTIVE_SEED = previous;
        }
        expect(+(await ds.query('SELECT count(*)::int AS n FROM xml_import_files'))[0].n).toBe(0);
        const rows = await ds.getRepository(AuditLog).find({ order: { id: 'DESC' } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor_type: AuditActorType.system, actor_user_id: null, actor_username: null, actor_role: null, action: AuditAction.system_seed, entity_type: AuditEntityType.system, entity_id: null, issuance_id: null, batch_id: null, details: { users: seedUsers.length, couriers: seedCouriers.length, issuances: 30 } });

        const manager = seedUsers.find((u) => u.role === UserRole.manager);
        const token = await tokenFor(app, manager.username);
        expect(token).toBeTruthy();
        const read = await audit(token);
        expect(read.items.map((r) => r.action)).toEqual([AuditAction.auth_login, AuditAction.system_seed]);
        //the system row has no user to name, the login names the seeded manager
        expect(read.items.map((r) => r.actor_name)).toEqual([manager.display_name, null]);
        //the seeded manager is the mock manager identity: linked to a courier row, so the courier screens open for them
        const me = await get('/api/auth/me', token);
        expect(typeof me.body.courier_id).toBe('number');
        expect(me.body.roles).toEqual([UserRole.manager, UserRole.courier]);
        expect((await get('/api/delivery/tasks', token)).status).toBe(200);
    });
});
