import './setup-env';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';

import { AppModule } from '../app.module';
import { IssuanceStatus, TaskStatus, UserRole } from '../../../shared/@core';
import { User, Courier, Issuance, DeliveryTask } from '../entities';

//the ניהול שליחים routes against the same throwaway database as hardening.e2e.spec.ts (docker compose up -d first)

let app: INestApplication;
let ds: DataSource;
let managerToken: string;
let courierToken: string;

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

//a manager and a courier login, nothing else. the couriers under test come in through the routes
async function reset() {
    await ds.query('TRUNCATE TABLE xml_outbox, audit_log, delivery_conflicts, delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');
    const hash = await bcrypt.hash('1234', 4);
    await ds.getRepository(User).save({ username: 'm', password_hash: hash, display_name: 'manager', role: UserRole.manager });
    await ds.getRepository(User).save({ username: 'c', password_hash: hash, display_name: 'courier', role: UserRole.courier });
    managerToken = (await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'm', password: '1234' })).body.token;
    courierToken = (await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'c', password: '1234' })).body.token;
    expect(managerToken).toBeTruthy();
    expect(courierToken).toBeTruthy();
}

//the first two rows of the design screen
const yossi = { name: 'יוסי כהן', id_number: '300789909', phone: '052-4438192' };
const david = { name: 'דוד לוי', id_number: '301289087', phone: '052-5789765' };

function post(path: string, body: any, token = managerToken) {
    return request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body);
}

function patch(path: string, body: any) {
    return request(app.getHttpServer()).patch(path).set('Authorization', `Bearer ${managerToken}`).send(body);
}

function del(path: string, token = managerToken) {
    return request(app.getHttpServer()).delete(path).set('Authorization', `Bearer ${token}`);
}

//what the management table and the assign dialog would show, in the server's order (by name)
async function names() {
    const res = await request(app.getHttpServer()).get('/api/couriers').set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    return res.body.map((c) => c.name);
}

//an issuance on its way with this courier
async function openTaskFor(courierId: number) {
    const issuance = await ds.getRepository(Issuance).save({ sap_number: String(7000000 + courierId), status: IssuanceStatus.assigned, customer_name: 'x', address_street: 'y', address_city: 'z' } as any);
    return ds.getRepository(DeliveryTask).save({ issuance_id: issuance.id, courier_id: courierId, status: TaskStatus.pending });
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('add and edit', () => {
    it('normalizes the form, refuses the same id twice and refuses bad fields', async () => {
        await reset();
        const res = await post('/api/couriers', { name: '  יוסי  כהן ', id_number: '300-789-909', phone: '0524438192' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ name: 'יוסי כהן', id_number: '300789909', phone: '052-4438192', active: true });

        const dup = await post('/api/couriers', { ...david, id_number: yossi.id_number });
        expect(dup.status).toBe(409);
        expect(dup.body.message).toContain('יוסי כהן');

        expect((await post('/api/couriers', { ...david, id_number: '12345' })).status).toBe(400);
        expect((await post('/api/couriers', { ...david, phone: '12345' })).status).toBe(400);
        expect((await post('/api/couriers', { ...david, name: '  ' })).status).toBe(400);

        expect(await names()).toEqual(['יוסי כהן']);
    });

    it('edits every field and keeps the id unique across rows', async () => {
        await reset();
        const a = (await post('/api/couriers', yossi)).body;
        await post('/api/couriers', david);

        const edited = await patch(`/api/couriers/${a.id}`, { name: 'יוסי כהן-לוי', id_number: '400789909', phone: '0545790087' });
        expect(edited.status).toBe(200);
        expect(edited.body).toMatchObject({ id: a.id, name: 'יוסי כהן-לוי', id_number: '400789909', phone: '054-5790087' });

        expect((await patch(`/api/couriers/${a.id}`, { ...yossi, id_number: david.id_number })).status).toBe(409);
        expect((await patch('/api/couriers/999', yossi)).status).toBe(404);
    });

    it('is for managers only', async () => {
        await reset();
        expect((await post('/api/couriers', yossi, courierToken)).status).toBe(403);
        expect((await del('/api/couriers/1', courierToken)).status).toBe(403);
    });
});

describe('delete', () => {
    it('hides the courier, keeps the row, and brings it back when the same id is added again', async () => {
        await reset();
        const a = (await post('/api/couriers', yossi)).body;
        await post('/api/couriers', david);

        expect((await del(`/api/couriers/${a.id}`)).status).toBe(200);
        expect(await names()).toEqual(['דוד לוי']);
        expect((await ds.getRepository(Courier).findOne({ where: { id: a.id } })).active).toBe(false);
        expect((await del(`/api/couriers/${a.id}`)).status).toBe(404);

        //the same person again: the old row, new phone, no second row
        const back = await post('/api/couriers', { ...yossi, phone: '050-0000000' });
        expect(back.status).toBe(201);
        expect(back.body).toMatchObject({ id: a.id, phone: '050-0000000', active: true });
        expect(await names()).toEqual(['דוד לוי', 'יוסי כהן']);
        expect(await ds.getRepository(Courier).count()).toBe(2);
    });

    it('refuses a courier with an open delivery and names them, all or nothing for a batch', async () => {
        await reset();
        const a = (await post('/api/couriers', yossi)).body;
        const b = (await post('/api/couriers', david)).body;
        await openTaskFor(a.id);

        const one = await del(`/api/couriers/${a.id}`);
        expect(one.status).toBe(409);
        expect(one.body.busy).toEqual([{ id: a.id, name: 'יוסי כהן', count: 1 }]);

        const both = await post('/api/couriers/remove', { ids: [a.id, b.id] });
        expect(both.status).toBe(409);
        expect(await names()).toEqual(['דוד לוי', 'יוסי כהן']);

        //the delivery closes, now the courier can go
        await ds.getRepository(DeliveryTask).update({ courier_id: a.id }, { status: TaskStatus.done });
        expect((await post('/api/couriers/remove', { ids: [a.id, b.id] })).status).toBe(201);
        expect(await names()).toEqual([]);
        expect((await post('/api/couriers/remove', { ids: [] })).status).toBe(400);
    });

    it('a deleted courier cannot be assigned', async () => {
        await reset();
        const a = (await post('/api/couriers', yossi)).body;
        const issuance = await ds.getRepository(Issuance).save({ sap_number: '7000001', status: IssuanceStatus.unassigned, customer_name: 'x', address_street: 'y', address_city: 'z' } as any);
        await del(`/api/couriers/${a.id}`);
        expect((await post('/api/issuances/assign', { ids: [issuance.id], courier_id: a.id })).status).toBe(404);
        expect(await ds.getRepository(DeliveryTask).count()).toBe(0);
    });
});
