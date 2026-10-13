import './setup-env';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../app.module';
import { AttemptOutcome, AuditAction, AuditEntityType, IAuditPage, IIssuance, IssuanceStatus, NonDeliveryReason, RecipientType, ReportConflictCode, TaskStatus, UserRole } from '../../../shared/@core';
import { User, Courier, Issuance, IssuanceItem, DeliveryTask, DeliveryAttempt, DeliveryOperation, DeliveryConflict } from '../entities';
import { SAMPLE_SIGNATURE } from '../seed/seed.data';

//one SAP line off an issuance (DELETE /api/issuances/:id/items/:itemId) against the same throwaway database as the other
//e2e specs: the matrix of docs/plans/remove-issuance-item.md row by row, what the rest of the issuance looks like after,
//what a refused call leaves behind, and the path a tablet report written against the old line set takes

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

type Fixture = { issuance: Issuance; task: DeliveryTask; manager: User; courier: Courier; managerToken: string; courierToken: string; a: number; b: number };

const OP_A = 'a0d17000-0000-4000-8000-000000000021';
const OP_B = 'a0d17000-0000-4000-8000-000000000022';

//one manager, one courier with a login, one assigned issuance with two lines (a, b) and its pending task
async function fixture(): Promise<Fixture> {
    await ds.query('TRUNCATE TABLE audit_log, delivery_conflicts, delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');
    const hash = await bcrypt.hash('1234', 4);

    const manager = await ds.getRepository(User).save({ username: 'm', password_hash: hash, display_name: 'דנה', role: UserRole.manager });
    const courierUser = await ds.getRepository(User).save({ username: 'c', password_hash: hash, display_name: 'courier', role: UserRole.courier });
    const courier = await ds.getRepository(Courier).save({ name: 'courier one', user_id: courierUser.id });

    const issuance = await twoLines(IssuanceStatus.assigned, '7000001');
    const task = await ds.getRepository(DeliveryTask).save({ issuance_id: issuance.id, courier_id: courier.id, status: TaskStatus.pending });

    const login = async (username: string) => (await request(app.getHttpServer()).post('/api/auth/login').send({ username, password: '1234' })).body.token;
    const f = { issuance, task, manager, courier, managerToken: await login('m'), courierToken: await login('c'), a: issuance.items[0].id, b: issuance.items[1].id };
    expect(f.managerToken && f.courierToken).toBeTruthy();
    return f;
}

//an issuance with two lines in the given status; the first line carries every optional field so "unchanged" means all of them
async function twoLines(status: IssuanceStatus, sapNumber?: string) {
    return ds.getRepository(Issuance).save({
        sap_number: sapNumber || `70000${10 + (await ds.getRepository(Issuance).count())}`,
        status,
        customer_name: 'ישראל ישראלי',
        customer_id_number: '012345678',
        customer_phone: '050-1234567',
        address_street: 'הרצל 10',
        address_city: 'תל אביב',
        items: [
            { line_no: 1, product_name: 'מחשב', catalog_number: 'C-1', station_number: 'S-1', serial_number: 'SN-1', quantity: 1 },
            { line_no: 2, product_name: 'מקלדת', quantity: 2 },
        ],
    } as any);
}

function del(path: string, token: string) {
    return request(app.getHttpServer()).delete(path).set('Authorization', `Bearer ${token}`);
}

function get(path: string, token: string) {
    return request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
}

function post(path: string, token: string, body: any) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

async function detail(f: Fixture): Promise<IIssuance> {
    const res = await get(`/api/issuances/${f.issuance.id}`, f.managerToken);
    expect(res.status).toBe(200);
    return res.body;
}

async function rowsOf(token: string, action: AuditAction) {
    const res = await get(`/api/audit?action=${action}&size=100`, token);
    expect(res.status).toBe(200);
    return (res.body as IAuditPage).items;
}

async function auditTotal(token: string) {
    return ((await get('/api/audit', token)).body as IAuditPage).total;
}

//the report the tablet signed: everything delivered, against the lines and the revision it downloaded
function delivered(items: number[], revision: number, operationId: string) {
    return { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: items.map((item_id) => ({ item_id, delivered: true })), operation_id: operationId, issuance_revision: revision, client_reported_at: '2026-10-13T08:00:00.000Z' };
}

//nothing handed over: no recipient, no signature, the issuance ends not_delivered, the one closed status a line may still leave
function refused(items: number[], revision: number, operationId: string) {
    return { items: items.map((item_id) => ({ item_id, delivered: false, reason: NonDeliveryReason.nobody_home, reason_details: 'אין מענה' })), operation_id: operationId, issuance_revision: revision, client_reported_at: '2026-10-13T08:00:00.000Z' };
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('removing one line', () => {
    it('one of two lines goes: the other is the same byte for byte, the revision moves, the task and its courier stay, one audit row', async () => {
        const f = await fixture();
        const before = await detail(f);
        expect(before.items.map((i) => i.id)).toEqual([f.a, f.b]);
        expect(before.revision).toBe(1);

        const res = await del(`/api/issuances/${f.issuance.id}/items/${f.b}`, f.managerToken);
        expect(res.status).toBe(200);
        const body: IIssuance = res.body;
        expect(body.items).toEqual([before.items[0]]);
        expect(body.revision).toBe(2);
        expect(body.status).toBe(IssuanceStatus.assigned);
        expect(body.current_task).toMatchObject({ id: f.task.id, status: TaskStatus.pending, courier_id: f.courier.id, courier: { name: 'courier one' } });

        //the detail, the board row and the courier's task all list the live line only
        expect((await detail(f)).items).toEqual([before.items[0]]);
        const board = await get('/api/issuances?search=7000001', f.managerToken);
        expect(board.body.rows[0].items.map((i: IIssuance['items'][number]) => i.id)).toEqual([f.a]);
        const mine = await get(`/api/delivery/tasks/${f.task.id}`, f.courierToken);
        expect(mine.status).toBe(200);
        expect(mine.body.status).toBe(TaskStatus.pending);
        expect(mine.body.issuance.items.map((i: IIssuance['items'][number]) => i.id)).toEqual([f.a]);
        //the list the tablet downloads for offline work is a hand written join, not the find above: same answer
        const list = await get('/api/delivery/tasks', f.courierToken);
        expect(list.body.rows.map((t: any) => t.issuance.items.map((i: IIssuance['items'][number]) => i.id))).toEqual([[f.a]]);

        //the row is still there, marked, so an attempt line of the past can keep pointing at it
        const kept = await ds.getRepository(IssuanceItem).findOne({ where: { id: f.b }, withDeleted: true });
        expect(kept.removed_at).toBeInstanceOf(Date);
        expect(await ds.getRepository(IssuanceItem).count({ where: { issuance_id: f.issuance.id } })).toBe(1);
        expect(await ds.getRepository(DeliveryTask).find({ where: { issuance_id: f.issuance.id } })).toHaveLength(1);

        const rows = await rowsOf(f.managerToken, AuditAction.issuance_remove_item);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor_user_id: f.manager.id, actor_role: UserRole.manager, entity_type: AuditEntityType.issuance, entity_id: f.issuance.id, issuance_id: f.issuance.id, batch_id: null });
        expect(rows[0].details).toEqual({ item_id: f.b, line_no: 2, product_name: 'מקלדת', items_left: 1, revision: 2 });
    });

    it('a line already removed, a line of another issuance, a bad id and an unknown issuance are refused and write nothing', async () => {
        const f = await fixture();
        expect((await del(`/api/issuances/${f.issuance.id}/items/${f.b}`, f.managerToken)).status).toBe(200);
        const other = await twoLines(IssuanceStatus.unassigned);
        const total = await auditTotal(f.managerToken);

        const again = await del(`/api/issuances/${f.issuance.id}/items/${f.b}`, f.managerToken);
        expect(again.status).toBe(404);
        expect(again.body.message).toBe(`item ${f.b} not found in issuance ${f.issuance.id}`);

        const foreign = await del(`/api/issuances/${f.issuance.id}/items/${other.items[0].id}`, f.managerToken);
        expect(foreign.status).toBe(404);
        expect(foreign.body.message).toBe(`item ${other.items[0].id} not found in issuance ${f.issuance.id}`);

        expect((await del(`/api/issuances/${f.issuance.id}/items/abc`, f.managerToken)).status).toBe(400);
        expect((await del(`/api/issuances/${f.issuance.id}/items/0`, f.managerToken)).status).toBe(400);
        expect((await del(`/api/issuances/${f.issuance.id}/items/1.5`, f.managerToken)).status).toBe(400);
        //past int4 the database would answer with an error (500) instead; the issuance id from the path is checked the same way
        expect((await del(`/api/issuances/${f.issuance.id}/items/99999999999`, f.managerToken)).status).toBe(400);
        expect((await del(`/api/issuances/abc/items/${f.a}`, f.managerToken)).status).toBe(400);
        expect((await del(`/api/issuances/99999999999/items/${f.a}`, f.managerToken)).status).toBe(400);

        const missing = await del(`/api/issuances/999999/items/${f.a}`, f.managerToken);
        expect(missing.status).toBe(404);
        expect(missing.body.message).toBe('issuance 999999 not found');

        expect(await auditTotal(f.managerToken)).toBe(total);
        expect((await detail(f)).revision).toBe(2);
        expect(await ds.getRepository(IssuanceItem).count({ where: { issuance_id: other.id } })).toBe(2);
    });

    it('the last line is refused with last_item and stays', async () => {
        const f = await fixture();
        expect((await del(`/api/issuances/${f.issuance.id}/items/${f.b}`, f.managerToken)).status).toBe(200);
        const total = await auditTotal(f.managerToken);

        const res = await del(`/api/issuances/${f.issuance.id}/items/${f.a}`, f.managerToken);
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ statusCode: 409, message: 'issuance 7000001 has one item left, delete the issuance instead', code: 'last_item', sap_number: '7000001' });

        const after = await detail(f);
        expect(after.items.map((i) => i.id)).toEqual([f.a]);
        expect(after.revision).toBe(2);
        expect(after.status).toBe(IssuanceStatus.assigned);
        expect(await auditTotal(f.managerToken)).toBe(total);
    });

    it('closed statuses answer status_not_allowed with the action, the edit statuses all let a line go, a courier is refused', async () => {
        const f = await fixture();
        for (const status of [IssuanceStatus.delivered, IssuanceStatus.partially_delivered, IssuanceStatus.deleted]) {
            await ds.getRepository(Issuance).update(f.issuance.id, { status });
            const res = await del(`/api/issuances/${f.issuance.id}/items/${f.b}`, f.managerToken);
            expect(res.status).toBe(409);
            expect(res.body).toMatchObject({ code: 'status_not_allowed', sap_number: '7000001', status, action: 'remove_item' });
        }
        await ds.getRepository(Issuance).update(f.issuance.id, { status: IssuanceStatus.assigned });

        expect((await del(`/api/issuances/${f.issuance.id}/items/${f.b}`, f.courierToken)).status).toBe(403);
        expect((await request(app.getHttpServer()).delete(`/api/issuances/${f.issuance.id}/items/${f.b}`)).status).toBe(401);

        expect(await rowsOf(f.managerToken, AuditAction.issuance_remove_item)).toHaveLength(0);
        expect((await detail(f)).items).toHaveLength(2);
        expect((await detail(f)).revision).toBe(1);

        //the other statuses of the edit row, each on its own two line issuance: the status is untouched by the removal
        for (const status of [IssuanceStatus.unassigned, IssuanceStatus.not_delivered, IssuanceStatus.self_pickup]) {
            const i = await twoLines(status);
            const res = await del(`/api/issuances/${i.id}/items/${i.items[1].id}`, f.managerToken);
            expect(res.status).toBe(200);
            expect(res.body.status).toBe(status);
            expect(res.body.revision).toBe(2);
            expect(res.body.items.map((x: IIssuance['items'][number]) => x.id)).toEqual([i.items[0].id]);
        }
        expect(await rowsOf(f.managerToken, AuditAction.issuance_remove_item)).toHaveLength(3);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('the tablet after a removal', () => {
    it('a report signed against the old line set is refused under the lock as revision_changed, a fresh one goes through', async () => {
        const f = await fixture();
        expect((await del(`/api/issuances/${f.issuance.id}/items/${f.b}`, f.managerToken)).status).toBe(200);

        //both lines at revision 1, the snapshot the tablet took before the manager acted
        const stale = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, delivered([f.a, f.b], 1, OP_A));
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe(ReportConflictCode.revision_changed);
        expect(await ds.getRepository(DeliveryAttempt).count()).toBe(0);
        expect(await ds.getRepository(DeliveryOperation).count()).toBe(0);
        expect(await rowsOf(f.managerToken, AuditAction.delivery_report)).toHaveLength(0);
        expect((await detail(f)).status).toBe(IssuanceStatus.assigned);

        //the tablet files it as evidence like any other 409, with the revision it was written against
        const kept = await post(`/api/delivery/tasks/${f.task.id}/conflicts`, f.courierToken, delivered([f.a, f.b], 1, OP_A));
        expect(kept.status).toBe(201);
        const row = await ds.getRepository(DeliveryConflict).findOne({ where: { id: kept.body.conflict_id } });
        expect(row).toMatchObject({ rejection_code: ReportConflictCode.revision_changed, submitted_revision: 1 });

        //the removed line counts as known only for a report that is behind: at the current revision it is a bad payload
        const wrong = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, delivered([f.a, f.b], 2, OP_B));
        expect(wrong.status).toBe(400);

        //the tablet refreshed: the one live line at the new revision
        const fresh = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, delivered([f.a], 2, OP_B));
        expect(fresh.status).toBe(201);
        expect(fresh.body.outcome).toBe(AttemptOutcome.delivered);
        const after = await detail(f);
        expect(after).toMatchObject({ status: IssuanceStatus.delivered, revision: 3 });
        expect(after.current_task.attempts[0].items.map((i) => i.item_id)).toEqual([f.a]);
    });

    it('a replay of a report applied before the removal is still answered from the stored operation', async () => {
        const f = await fixture();
        const first = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, refused([f.a, f.b], 1, OP_A));
        expect(first.status).toBe(201);
        expect(first.body.outcome).toBe(AttemptOutcome.not_delivered);
        expect((await detail(f)).status).toBe(IssuanceStatus.not_delivered);

        expect((await del(`/api/issuances/${f.issuance.id}/items/${f.b}`, f.managerToken)).status).toBe(200);
        expect((await detail(f)).revision).toBe(3);

        //the response the tablet never saw, asked for again with the lines and the revision it signed
        const again = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, refused([f.a, f.b], 1, OP_A));
        expect(again.status).toBe(201);
        expect(again.body).toEqual({ ...first.body, replayed: true });
        expect(await ds.getRepository(DeliveryAttempt).count()).toBe(1);

        //the attempt keeps naming the removed line, the issuance no longer lists it
        const after = await detail(f);
        expect(after.current_task.attempts[0].items.map((i) => i.item_id).sort((x, y) => x - y)).toEqual([f.a, f.b]);
        expect(after.items.map((i) => i.id)).toEqual([f.a]);

        //a different operation against the old lines on the closed task: the task answer as before, not a 400
        const other = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, refused([f.a, f.b], 1, OP_B));
        expect(other.status).toBe(409);
        expect(other.body.code).toBe(ReportConflictCode.task_closed);
    });

    //a third line, so one removal can predate the tablet's download and one follow it
    async function thirdLine(f: Fixture) {
        return (await ds.getRepository(IssuanceItem).save({ issuance_id: f.issuance.id, line_no: 3, product_name: 'עכבר', quantity: 1 })).id;
    }

    it('a snapshot taken between two removals still reaches the lock: the lines it names count, not every removed one', async () => {
        const f = await fixture();
        const c = await thirdLine(f);
        expect((await del(`/api/issuances/${f.issuance.id}/items/${c}`, f.managerToken)).status).toBe(200);
        expect((await detail(f)).revision).toBe(2);
        //the tablet downloads [a, b] at revision 2, then b goes as well
        expect((await del(`/api/issuances/${f.issuance.id}/items/${f.b}`, f.managerToken)).status).toBe(200);
        expect((await detail(f)).revision).toBe(3);

        //no 400 for the missing answer on c, which the snapshot never knew: the revision check decides
        const stale = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, delivered([f.a, f.b], 2, OP_A));
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe(ReportConflictCode.revision_changed);
        expect(await ds.getRepository(DeliveryAttempt).count()).toBe(0);

        //an id that never belonged, or the same line twice, is still a bad payload even when behind
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, delivered([f.a, 999999], 2, OP_A))).status).toBe(400);
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, delivered([f.a, f.b, f.b], 2, OP_A))).status).toBe(400);
        expect((await detail(f)).status).toBe(IssuanceStatus.assigned);
    });

    it('a replay after two removals is still answered from the stored operation', async () => {
        const f = await fixture();
        const c = await thirdLine(f);
        expect((await del(`/api/issuances/${f.issuance.id}/items/${c}`, f.managerToken)).status).toBe(200); //revision 2

        const first = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, refused([f.a, f.b], 2, OP_A));
        expect(first.status).toBe(201); //revision 3, not_delivered
        expect((await del(`/api/issuances/${f.issuance.id}/items/${f.b}`, f.managerToken)).status).toBe(200); //revision 4

        const again = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, refused([f.a, f.b], 2, OP_A));
        expect(again.status).toBe(201);
        expect(again.body).toEqual({ ...first.body, replayed: true });
        expect(await ds.getRepository(DeliveryAttempt).count()).toBe(1);
        expect((await detail(f)).items.map((i) => i.id)).toEqual([f.a]);
    });
});
