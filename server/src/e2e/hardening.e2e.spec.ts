import './setup-env';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../app.module';
import { tokenFor } from './auth-helper';
import { IssuanceStatus, NonDeliveryReason, RecipientType, TaskStatus, UserRole } from '../../../shared/@core';
import { User, Courier, Issuance, DeliveryTask, DeliveryAttempt } from '../entities';
import { SAMPLE_SIGNATURE } from '../seed/seed.data';

//assignment and delivery flows against a real postgres (docker compose up -d first). the database equipment_supply_test
//is created on the first run and wiped before every test

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

type Fixture = { issuance: Issuance; task: DeliveryTask; otherCourier: Courier; managerToken: string; courierToken: string; itemIds: number[] };

//one manager, one courier with a login, one courier without, one issuance with two lines assigned to the first courier
async function fixture(): Promise<Fixture> {
    await ds.query('TRUNCATE TABLE xml_outbox, audit_log, delivery_conflicts, delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');

    const manager = await ds.getRepository(User).save({ username: 'm', display_name: 'manager', role: UserRole.manager });
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

    const managerToken = await tokenFor(app, 'm');
    const courierToken = await tokenFor(app, 'c');
    expect(managerToken).toBeTruthy();
    expect(courierToken).toBeTruthy();

    void manager;
    return { issuance, task, otherCourier, managerToken, courierToken, itemIds: issuance.items.map((i) => i.id) };
}

function post(path: string, token: string, body: any) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

function allDelivered(f: Fixture) {
    return { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: f.itemIds.map((item_id) => ({ item_id, delivered: true })) };
}

function noneDelivered(f: Fixture) {
    return { recipient_type: RecipientType.customer, signature_png: SAMPLE_SIGNATURE, items: f.itemIds.map((item_id) => ({ item_id, delivered: false, reason: NonDeliveryReason.nobody_home, reason_details: 'אין אף אחד' })) };
}

async function state(issuanceId: number) {
    const issuance = await ds.getRepository(Issuance).findOne({ where: { id: issuanceId } });
    const tasks = await ds.getRepository(DeliveryTask).find({ where: { issuance_id: issuanceId }, order: { id: 'ASC' } });
    const attempts = await ds.getRepository(DeliveryAttempt).count();
    return { status: issuance.status, tasks: tasks.map((t) => t.status), pending: tasks.filter((t) => t.status === TaskStatus.pending).length, attempts };
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('malformed item answers over http', () => {
    it('a string delivered is a 400 and nothing is written', async () => {
        const f = await fixture();
        const body = { ...allDelivered(f), items: [{ item_id: f.itemIds[0], delivered: 'true' }, { item_id: f.itemIds[1], delivered: true }] };
        const res = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, body);
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('delivered must be true or false');
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.assigned, pending: 1, attempts: 0 });
    });

    it('a duplicate item id and a missing signature are 400s too', async () => {
        const f = await fixture();
        const dup = { ...allDelivered(f), items: [{ item_id: f.itemIds[0], delivered: true }, { item_id: f.itemIds[0], delivered: true }] };
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, dup)).status).toBe(400);
        const noSig = { ...allDelivered(f), signature_png: '' };
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, noSig)).status).toBe(400);
        expect(await state(f.issuance.id)).toMatchObject({ pending: 1, attempts: 0 });
    });
});

describe('nothing delivered', () => {
    it('a report whose every line is not delivered needs no recipient and no signature, and stores none', async () => {
        const f = await fixture();
        const bare = { items: noneDelivered(f).items };
        const res = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, bare);
        expect(res.status).toBe(201);
        expect(res.body.outcome).toBe('not_delivered');

        const attempt = await ds.getRepository(DeliveryAttempt).findOne({ where: { id: res.body.attempt_id } });
        expect(attempt).toMatchObject({ recipient_type: null, recipient_name: null, recipient_id_number: null, recipient_phone: null, signature_png: null });
        expect(await state(f.issuance.id)).toEqual({ status: IssuanceStatus.not_delivered, tasks: [TaskStatus.done], pending: 0, attempts: 1 });

        //the courier's task screen and the manager's detail read the attempt back with the nulls, not with a made up customer
        const detail = await request(app.getHttpServer()).get(`/api/delivery/tasks/${f.task.id}`).set('Authorization', `Bearer ${f.courierToken}`);
        expect(detail.status).toBe(200);
        expect(detail.body.attempts[0]).toMatchObject({ recipient_type: null, recipient_name: null, signature_png: null });
    });

    it('the customer sent along by an older tablet build is still stored, and one delivered line still needs a signature', async () => {
        const f = await fixture();
        const legacy = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, noneDelivered(f));
        expect(legacy.status).toBe(201);
        const attempt = await ds.getRepository(DeliveryAttempt).findOne({ where: { id: legacy.body.attempt_id } });
        expect(attempt).toMatchObject({ recipient_type: RecipientType.customer, recipient_name: 'ישראל ישראלי', signature_png: SAMPLE_SIGNATURE });

        const g = await fixture();
        const partial = { items: [{ item_id: g.itemIds[0], delivered: true }, { item_id: g.itemIds[1], delivered: false, reason: NonDeliveryReason.customer_refused, reason_details: 'לא רצה' }] };
        const noRecipient = await post(`/api/delivery/tasks/${g.task.id}/attempts`, g.courierToken, partial);
        expect(noRecipient.status).toBe(400);
        expect(noRecipient.body.message).toContain('recipient_type');
        const noSignature = await post(`/api/delivery/tasks/${g.task.id}/attempts`, g.courierToken, { ...partial, recipient_type: RecipientType.customer });
        expect(noSignature.status).toBe(400);
        expect(noSignature.body.message).toContain('signature_png');
        expect(await state(g.issuance.id)).toMatchObject({ status: IssuanceStatus.assigned, pending: 1, attempts: 0 });
    });
});

describe('duplicate submissions', () => {
    it('two concurrent reports on the same task: one 201, one 409, one attempt', async () => {
        const f = await fixture();
        const [a, b] = await Promise.all([
            post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, allDelivered(f)),
            post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, allDelivered(f)),
        ]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        expect(await state(f.issuance.id)).toEqual({ status: IssuanceStatus.delivered, tasks: [TaskStatus.done], pending: 0, attempts: 1 });
    });

    it('a second report after the first one is a 409', async () => {
        const f = await fixture();
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, allDelivered(f))).status).toBe(201);
        const again = await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, allDelivered(f));
        expect(again.status).toBe(409);
        expect((await state(f.issuance.id)).attempts).toBe(1);
    });
});

describe('completed issuance', () => {
    it('a delivered issuance cannot be assigned, deleted or moved to self pickup', async () => {
        const f = await fixture();
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, allDelivered(f))).status).toBe(201);

        const assign = await post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.otherCourier.id });
        expect(assign.status).toBe(409);
        expect(assign.body.message).toContain('delivered, assign is not allowed');

        const del = await request(app.getHttpServer()).delete(`/api/issuances/${f.issuance.id}`).set('Authorization', `Bearer ${f.managerToken}`).send({ reason: 'x' });
        expect(del.status).toBe(409);

        const pickup = await request(app.getHttpServer()).patch(`/api/issuances/${f.issuance.id}`).set('Authorization', `Bearer ${f.managerToken}`).send({ self_pickup: true });
        expect(pickup.status).toBe(409);

        expect(await state(f.issuance.id)).toEqual({ status: IssuanceStatus.delivered, tasks: [TaskStatus.done], pending: 0, attempts: 1 });
    });

    it('a partially delivered issuance is frozen: no new task until the remaining items rule is decided', async () => {
        const f = await fixture();
        const partial = { ...allDelivered(f), items: [{ item_id: f.itemIds[0], delivered: true }, { item_id: f.itemIds[1], delivered: false, reason: NonDeliveryReason.customer_refused, reason_details: 'לא רצה' }] };
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, partial)).status).toBe(201);

        const assign = await post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.otherCourier.id });
        expect(assign.status).toBe(409);
        expect(assign.body.message).toContain('partially_delivered');
        expect(await state(f.issuance.id)).toMatchObject({ status: IssuanceStatus.partially_delivered, pending: 0 });
    });

    it('a not delivered issuance can be sent again, the old task stays as history', async () => {
        const f = await fixture();
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, noneDelivered(f))).status).toBe(201);

        const assign = await post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.otherCourier.id });
        expect(assign.status).toBe(201);
        expect(await state(f.issuance.id)).toEqual({ status: IssuanceStatus.assigned, tasks: [TaskStatus.done, TaskStatus.pending], pending: 1, attempts: 1 });
    });

    it('a batch with one closed issuance writes nothing', async () => {
        const f = await fixture();
        const open = await ds.getRepository(Issuance).save({ sap_number: '7000002', status: IssuanceStatus.unassigned, customer_name: 'x', address_street: 'y', address_city: 'z' } as any);
        expect((await post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, allDelivered(f))).status).toBe(201);

        const assign = await post('/api/issuances/assign', f.managerToken, { ids: [open.id, f.issuance.id], courier_id: f.otherCourier.id });
        expect(assign.status).toBe(409);
        expect(await state(open.id)).toMatchObject({ status: IssuanceStatus.unassigned, pending: 0 });
    });
});

describe('report vs reassignment race', () => {
    //the report delivers everything, so whichever request lands second must fail: report first -> issuance is delivered and
    //assign gets 409, assign first -> the task is cancelled and the report gets 409. run it a few times, the winner varies
    it('exactly one of them wins and the rows stay consistent', async () => {
        for (let round = 0; round < 5; round++) {
            const f = await fixture();
            const [report, assign] = await Promise.all([
                post(`/api/delivery/tasks/${f.task.id}/attempts`, f.courierToken, allDelivered(f)),
                post('/api/issuances/assign', f.managerToken, { ids: [f.issuance.id], courier_id: f.otherCourier.id }),
            ]);
            const statuses = [report.status, assign.status].sort();
            expect(statuses).toEqual([201, 409]);

            const s = await state(f.issuance.id);
            if (report.status === 201) {
                expect(s).toEqual({ status: IssuanceStatus.delivered, tasks: [TaskStatus.done], pending: 0, attempts: 1 });
            } else {
                expect(s).toEqual({ status: IssuanceStatus.assigned, tasks: [TaskStatus.cancelled, TaskStatus.pending], pending: 1, attempts: 0 });
            }
        }
    });
});

describe('board sorting', () => {
    it('sorts by customer both ways, by courier with the unassigned last, and rejects an unknown column', async () => {
        const f = await fixture();
        //two more without a courier, names picked so the alphabet and the insertion order disagree
        await ds.getRepository(Issuance).save([
            { sap_number: '7000002', status: IssuanceStatus.unassigned, customer_name: 'תמר', address_street: 'y', address_city: 'z' },
            { sap_number: '7000003', status: IssuanceStatus.unassigned, customer_name: 'אבי', address_street: 'y', address_city: 'z' },
        ] as any);
        const list = (query: string) => request(app.getHttpServer()).get(`/api/issuances?${query}`).set('Authorization', `Bearer ${f.managerToken}`);

        const asc = await list('sort=customer&order=asc');
        expect(asc.status).toBe(200);
        expect(asc.body.rows.map((r) => r.customer_name)).toEqual(['אבי', 'ישראל ישראלי', 'תמר']);

        const desc = await list('sort=customer&order=desc');
        expect(desc.body.rows.map((r) => r.customer_name)).toEqual(['תמר', 'ישראל ישראלי', 'אבי']);

        //only the fixture issuance has a courier: it leads, the two without one follow in id order
        const byCourier = await list('sort=courier&order=asc');
        expect(byCourier.body.rows.map((r) => r.sap_number)).toEqual(['7000001', '7000002', '7000003']);
        expect(byCourier.body.rows[0].current_task.courier.name).toBe('courier one');
        expect(byCourier.body.total).toBe(3);

        expect((await list('sort=password')).status).toBe(400);
    });
});
