import './setup-env';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../app.module';
import { tokenFor } from './auth-helper';
import { AuthMode, IssuanceStatus, TaskStatus, UserRole } from '../../../shared/@core';
import { User, Courier, Issuance, DeliveryTask } from '../entities';
import { AUTH_PROVIDER } from '../auth/auth.provider';
import { CognitoAuthProvider } from '../auth/cognito/cognito-auth.provider';

//the auth foundation against the same throwaway database as the other e2e specs (docker compose up -d first): the mock
//login with the two identities, the public routes, the global guard on every other route, the role list and the
//resource check behind it. the matrix is in docs/plans/auth-foundation.md

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

type Fixture = { manager: User; managerCourier: Courier; courierUser: User; courier: Courier; solo: User; issuance: Issuance };

//the two users the mock identities map to (auth/mock/mock-identities.ts), each with a courier row, a manager without
//one, and one issuance assigned to the manager's courier row so the manager's courier view has something to show
async function fixture(): Promise<Fixture> {
    await ds.query('TRUNCATE TABLE xml_outbox, audit_log, delivery_conflicts, delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');
    const manager = await ds.getRepository(User).save({ username: 'manager', display_name: 'דנה לוי', email: 'manager@equipment.local', role: UserRole.manager });
    const managerCourier = await ds.getRepository(Courier).save({ name: 'דנה לוי', employee_id: 'E-1000', user_id: manager.id });
    const courierUser = await ds.getRepository(User).save({ username: 'courier1', display_name: 'יוסי אברהם', email: 'courier1@equipment.local', role: UserRole.courier });
    const courier = await ds.getRepository(Courier).save({ name: 'יוסי אברהם', user_id: courierUser.id });
    const solo = await ds.getRepository(User).save({ username: 'solo', display_name: 'manager without a courier row', role: UserRole.manager });

    const issuance = await ds.getRepository(Issuance).save({
        sap_number: '7100001',
        status: IssuanceStatus.assigned,
        customer_name: 'ישראל ישראלי',
        address_street: 'הרצל 10',
        address_city: 'תל אביב',
        items: [{ line_no: 1, product_name: 'מחשב', quantity: 1 }],
    } as any);
    await ds.getRepository(DeliveryTask).save({ issuance_id: issuance.id, courier_id: managerCourier.id, status: TaskStatus.pending });

    return { manager, managerCourier, courierUser, courier, solo, issuance };
}

function get(path: string, token?: string) {
    const req = request(app.getHttpServer()).get(path);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
}

function mockLogin(body?: any) {
    const req = request(app.getHttpServer()).post('/api/auth/mock/login');
    return body === undefined ? req : req.send(body);
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('the mock login', () => {
    it('manager: both roles and the courier row linked to the user; me answers the same user', async () => {
        const f = await fixture();
        const res = await mockLogin({ identity: 'manager' });
        expect(res.status).toBe(201);
        const expected = { id: f.manager.id, username: 'manager', name: 'דנה לוי', email: 'manager@equipment.local', roles: [UserRole.manager, UserRole.courier], courier_id: f.managerCourier.id };
        expect(res.body.user).toEqual(expected);
        expect(typeof res.body.token).toBe('string');
        //no sub and no password related field anywhere in the answer
        expect(Object.keys(res.body).sort()).toEqual(['token', 'user']);

        const me = await get('/api/auth/me', res.body.token);
        expect(me.status).toBe(200);
        expect(me.body).toEqual(expected);
    });

    it('courier: the courier role only and its courier row', async () => {
        const f = await fixture();
        const res = await mockLogin({ identity: 'courier' });
        expect(res.status).toBe(201);
        expect(res.body.user).toEqual({ id: f.courierUser.id, username: 'courier1', name: 'יוסי אברהם', email: 'courier1@equipment.local', roles: [UserRole.courier], courier_id: f.courier.id });
        expect((await get('/api/auth/me', res.body.token)).body).toEqual(res.body.user);
    });

    it('an unknown identity or no body is a 400 naming the two legal values', async () => {
        await fixture();
        for (const body of [{ identity: 'admin' }, { identity: 'Manager' }, { username: 'manager' }, {}, undefined]) {
            const res = await mockLogin(body);
            expect(res.status).toBe(400);
            expect(res.body.message).toBe('identity must be manager or courier');
        }
    });

    it('an identity whose users row is missing is a 503 that says to run the seed', async () => {
        await fixture();
        await ds.query('TRUNCATE TABLE delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');
        const res = await mockLogin({ identity: 'manager' });
        expect(res.status).toBe(503);
        expect(res.body.message).toBe('mock identity manager has no users row, run the seed');
    });

    it('outside mock mode the route answers 404; the mode route says which mode runs, without a token', async () => {
        await fixture();
        expect((await get('/api/auth/mode')).body).toEqual({ mode: AuthMode.mock });
        const previous = process.env.AUTH_MODE;
        process.env.AUTH_MODE = 'cognito';
        try {
            expect((await mockLogin({ identity: 'manager' })).status).toBe(404);
            expect((await get('/api/auth/mode')).body).toEqual({ mode: AuthMode.cognito });
        } finally {
            process.env.AUTH_MODE = previous;
        }
        expect((await mockLogin({ identity: 'manager' })).status).toBe(201);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('the global guard', () => {
    const guarded = ['/api/auth/me', '/api/issuances', '/api/couriers', '/api/conflicts', '/api/audit', '/api/xml-export', '/api/delivery/tasks', '/api/delivery/lookup?number=1'];

    it('every route but the two public ones is a 401 without a token, and with a token nobody signed', async () => {
        await fixture();
        for (const path of guarded) {
            const none = await get(path);
            expect([path, none.status, none.body.message]).toEqual([path, 401, 'missing token']);
            const bad = await get(path, 'not-a-jwt');
            expect([path, bad.status, bad.body.message]).toEqual([path, 401, 'token expired or invalid']);
        }
        //a route that does not exist is a 404 as before: a guard is bound to a handler, nothing is bound to nothing
        expect((await get('/api/nothing')).status).toBe(404);
        expect((await get('/api/auth/mode')).status).toBe(200);
        expect((await mockLogin({ identity: 'courier' })).status).toBe(201);
    });

    it('one of the listed roles is enough: a manager passes the courier routes, a courier does not pass the manager ones', async () => {
        const f = await fixture();
        const managerToken = await tokenFor(app, 'manager');
        const courierToken = await tokenFor(app, 'courier1');

        expect((await get('/api/couriers', managerToken)).status).toBe(200);
        const tasks = await get('/api/delivery/tasks', managerToken);
        expect(tasks.status).toBe(200);
        //the manager's own courier row: the one task assigned to it in the fixture
        expect(JSON.stringify(tasks.body)).toContain(f.issuance.sap_number);

        expect((await get('/api/delivery/tasks', courierToken)).status).toBe(200);
        for (const path of ['/api/couriers', '/api/issuances', '/api/conflicts', '/api/audit', '/api/xml-export']) {
            const res = await get(path, courierToken);
            expect([path, res.status, res.body.message]).toEqual([path, 403, 'wrong role for this route']);
        }
    });

    it('a manager without a courier row passes the role check and is refused by the resource check', async () => {
        await fixture();
        const token = await tokenFor(app, 'solo');
        expect((await get('/api/auth/me', token)).body).toMatchObject({ username: 'solo', roles: [UserRole.manager, UserRole.courier], courier_id: null });
        expect((await get('/api/couriers', token)).status).toBe(200);
        const res = await get('/api/delivery/tasks', token);
        expect(res.status).toBe(403);
        expect(res.body.message).toBe('this account is not linked to a courier');
    });

    //a second application booted with AUTH_MODE=cognito: the guard talks to the cognito provider, a token the mock
    //signed is refused there, nothing falls back to the mock
    it('in cognito mode the guard holds the cognito provider and a mock token is refused with the boundary message', async () => {
        const f = await fixture();
        const mockToken = await tokenFor(app, f.manager.username);
        const names = ['AUTH_MODE', 'COGNITO_REGION', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID'];
        const previous = Object.fromEntries(names.map((k) => [k, process.env[k]]));
        process.env.AUTH_MODE = 'cognito';
        process.env.COGNITO_REGION = 'il-central-1';
        process.env.COGNITO_USER_POOL_ID = 'il-central-1_test';
        process.env.COGNITO_CLIENT_ID = 'test-client';
        let cognitoApp: INestApplication | undefined;
        try {
            const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
            cognitoApp = moduleRef.createNestApplication();
            await cognitoApp.init();
            expect(cognitoApp.get(AUTH_PROVIDER)).toBeInstanceOf(CognitoAuthProvider);
            const res = await request(cognitoApp.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${mockToken}`);
            expect(res.status).toBe(401);
            expect(res.body.message).toBe('cognito token verification is not wired yet');
            expect((await request(cognitoApp.getHttpServer()).get('/api/auth/mode')).body).toEqual({ mode: AuthMode.cognito });
        } finally {
            await cognitoApp?.close();
            for (const k of names) {
                if (previous[k] === undefined) delete process.env[k];
                else process.env[k] = previous[k];
            }
        }
        //the first application still runs the mock
        expect((await get('/api/auth/me', mockToken)).status).toBe(200);
    });
});
