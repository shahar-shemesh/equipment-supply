import './setup-env';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../app.module';
import { AuditAction, IssuanceStatus, NonDeliveryReason, Priority, TaskStatus, UserRole } from '../../../shared/@core';
import { AuditLog } from '../entities';
import { buildBulkIssuances, buildIssuances, users as seedUsers } from '../seed/seed.data';
import { SeedService } from '../seed/seed.service';
import { DEV_PASSWORD } from '../auth/auth.constants';

//the manager board's offset paging on a seeded set with twenty pages: GET /api/issuances walked page by page and
//compared with sql on the same rows. the seed runs once with the 2000 generated rows, nothing here writes after it

let app: INestApplication;
let ds: DataSource;
let token: string;

const BULK = 2000;
const PAGE = 100; //the cap in issuances.service list(), the fewest requests per walk

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

    //SeedService.run checks the flag itself and setup-env does not set it
    const previous = process.env.ALLOW_DESTRUCTIVE_SEED;
    process.env.ALLOW_DESTRUCTIVE_SEED = 'true';
    try {
        await app.get(SeedService).run({ bulk: BULK });
    } finally {
        if (previous === undefined) delete process.env.ALLOW_DESTRUCTIVE_SEED;
        else process.env.ALLOW_DESTRUCTIVE_SEED = previous;
    }

    const manager = seedUsers.find((u) => u.role === UserRole.manager);
    token = (await request(app.getHttpServer()).post('/api/auth/login').send({ username: manager.username, password: DEV_PASSWORD })).body.token;
    expect(token).toBeTruthy();
}, 180000); //boot plus 2030 rows is 15 to 20 s here, the default 60 s is too close on a cold docker

afterAll(async () => {
    await app?.close();
});

/*──────────────────────────────────────────────────────────────────────────*/

//the courier pick of COURIER_NAME_SQL in issuances.service, so a sort by courier can be checked against sql
const COURIER_SQL = `(SELECT c.name FROM delivery_tasks t JOIN couriers c ON c.id = t.courier_id WHERE t.issuance_id = i.id AND t.status != '${TaskStatus.cancelled}' ORDER BY (t.status = '${TaskStatus.pending}') DESC, t.id DESC LIMIT 1)`;

async function list(query: string) {
    const res = await request(app.getHttpServer()).get(`/api/issuances?${query}`).set('Authorization', `Bearer ${token}`);
    expect([query, res.status]).toEqual([query, 200]);
    return res.body;
}

//every page of a query at the cap, with what every walk must hold: one total, pages that do not overlap, exactly total ids
async function walk(query: string) {
    const ids: number[] = [];
    const rows: any[] = [];
    let total = -1;
    for (let page = 1; ; page++) {
        const body = await list([query, `page=${page}`, `page_size=${PAGE}`].filter(Boolean).join('&'));
        if (total < 0) total = body.total;
        expect(body.total).toBe(total);
        expect(body.page).toBe(page);
        //an offset that is ignored would hand back page 1 forever: name the page instead of running into the timeout
        expect(page).toBeLessThanOrEqual(Math.ceil(total / PAGE) + 1);
        ids.push(...body.rows.map((r) => r.id));
        rows.push(...body.rows);
        if (body.rows.length < PAGE) break;
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(total);
    return { ids, rows, total };
}

//live rows under a predicate, the way list() counts them
async function count(where = 'TRUE', params: any[] = []) {
    const [row] = await ds.query(`SELECT COUNT(*)::int AS n FROM issuances i WHERE i.deleted_at IS NULL AND ${where}`, params);
    return row.n;
}

//the id tie break is the one list() adds after every sort
async function idsOrderedBy(orderBy: string) {
    const rows = await ds.query(`SELECT i.id FROM issuances i WHERE i.deleted_at IS NULL ORDER BY ${orderBy}, i.id ASC`);
    return rows.map((r) => +r.id);
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('the seeded set', () => {
    it('holds 30 handcrafted + 2000 generated issuances and the seed row counts them', async () => {
        const [{ n }] = await ds.query('SELECT COUNT(*)::int AS n FROM issuances');
        expect(n).toBe(30 + BULK);
        const row = await ds.getRepository(AuditLog).findOne({ where: { action: AuditAction.system_seed } });
        expect(row.details).toMatchObject({ issuances: 30 + BULK });
    });

    //the seed loop's rules per status, read back from the tables: nothing else observes the tasks and attempts it writes
    it('writes a task for every row with a courier and an attempt with its item answers for every closed one', async () => {
        const handcrafted = buildIssuances();
        const bulk = buildBulkIssuances(BULK);
        const rows = [...handcrafted, ...bulk];
        const withTask = rows.filter((r) => r.courier);
        const closed = withTask.filter((r) => r.status !== IssuanceStatus.assigned);
        const countOf = async (from: string) => (await ds.query(`SELECT COUNT(*)::int AS n FROM ${from}`))[0].n;

        expect(await countOf('issuance_items')).toBe(rows.reduce((n, r) => n + r.items.length, 0));
        expect(await countOf('delivery_tasks')).toBe(withTask.length);
        expect(await countOf(`delivery_tasks WHERE status = '${TaskStatus.pending}'`)).toBe(withTask.length - closed.length);
        expect(await countOf('delivery_attempts')).toBe(closed.length);
        expect(await countOf('delivery_attempt_items')).toBe(closed.reduce((n, r) => n + r.items.length, 0));

        //a generated partial delivery: line 1 delivered, the rest refused with a reason
        const partial = bulk.find((r) => r.status === IssuanceStatus.partially_delivered);
        const answers = await ds.query(
            'SELECT ai.delivered, ai.reason FROM delivery_attempt_items ai JOIN issuance_items ii ON ii.id = ai.item_id JOIN issuances i ON i.id = ii.issuance_id WHERE i.sap_number = $1 ORDER BY ii.line_no',
            [partial.sap_number],
        );
        expect(answers).toHaveLength(partial.items.length);
        expect(answers[0]).toEqual({ delivered: true, reason: null });
        for (const a of answers.slice(1)) expect(a).toEqual({ delivered: false, reason: NonDeliveryReason.nobody_home });
    });
});

describe('plain pages', () => {
    it('page 1 at the board size', async () => {
        const body = await list('page=1&page_size=15');
        expect(body.rows).toHaveLength(15);
        expect(body).toMatchObject({ total: await count(), page: 1, page_size: 15 });
    });

    it('a middle page, the last page and one past the end', async () => {
        const total = await count();
        const last = Math.ceil(total / PAGE);
        expect(last).toBeGreaterThan(2);

        const p1 = await list(`page=1&page_size=${PAGE}`);
        const p2 = await list(`page=2&page_size=${PAGE}`);
        expect(p2.rows).toHaveLength(PAGE);
        const first = new Set(p1.rows.map((r) => r.id));
        expect(p2.rows.some((r) => first.has(r.id))).toBe(false);

        expect((await list(`page=${last}&page_size=${PAGE}`)).rows).toHaveLength(total % PAGE || PAGE);
        expect(await list(`page=${last + 1}&page_size=${PAGE}`)).toEqual({ rows: [], total, page: last + 1, page_size: PAGE });
    });

    it('clamps the page size and a bad page instead of a 400, a bad sort is still a 400', async () => {
        const big = await list('page_size=500');
        expect(big.rows).toHaveLength(PAGE);
        expect(big.page_size).toBe(PAGE);
        expect((await list('page=0')).page).toBe(1);
        expect((await list('page=abc')).page).toBe(1);

        const res = await request(app.getHttpServer()).get('/api/issuances?sort=password').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(400);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('full walks', () => {
    it('no sort: urgent first, then delivery date, then id', async () => {
        const { ids } = await walk('');
        expect(ids).toEqual(await idsOrderedBy(`CASE i.priority WHEN '${Priority.urgent}' THEN 0 ELSE 1 END ASC, i.delivery_date ASC NULLS LAST`));
    });

    it.each([
        ['city', 'asc', 'i.address_city ASC NULLS LAST'],
        ['courier', 'desc', `${COURIER_SQL} DESC NULLS LAST`],
        ['number', 'desc', 'i.sap_number DESC NULLS LAST'],
    ])('sort=%s&order=%s is the sql order', async (sort, order, orderBy) => {
        const { ids } = await walk(`sort=${sort}&order=${order}`);
        expect(ids).toEqual(await idsOrderedBy(orderBy));
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('filters', () => {
    it('status=assigned, page 2 at the board size', async () => {
        const total = await count('i.status = $1', [IssuanceStatus.assigned]);
        const p1 = await list(`status=${IssuanceStatus.assigned}&page=1`);
        const p2 = await list(`status=${IssuanceStatus.assigned}&page=2`);
        expect([p1.total, p2.total]).toEqual([total, total]);
        expect(p2.rows).toHaveLength(15);
        for (const r of [...p1.rows, ...p2.rows]) expect(r.status).toBe(IssuanceStatus.assigned);
        const first = new Set(p1.rows.map((r) => r.id));
        expect(p2.rows.some((r) => first.has(r.id))).toBe(false);
    });

    it('city + priority', async () => {
        //the city with the most rows, the widest city filter the data has. with the generator its urgent rows still fit one
        //page at the cap; the multi page filtered walk is the status=assigned test above
        const [{ city }] = await ds.query('SELECT address_city AS city FROM issuances WHERE deleted_at IS NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1');
        const { rows, total } = await walk(`city=${encodeURIComponent(city)}&priority=${Priority.urgent}`);
        expect(total).toBe(await count('i.address_city = $1 AND i.priority = $2', [city, Priority.urgent]));
        expect(total).toBeGreaterThan(0);
        for (const r of rows) expect([r.address_city, r.priority]).toEqual([city, Priority.urgent]);
    });

    it('customer, a partial name', async () => {
        const part = 'כהן';
        const { rows, total } = await walk(`customer=${encodeURIComponent(part)}`);
        expect(total).toBe(await count('i.customer_name ILIKE $1', [`%${part}%`]));
        expect(total).toBeGreaterThan(0);
        for (const r of rows) expect(r.customer_name).toContain(part);
    });

    it('courier_id, the open tasks of one courier', async () => {
        const [{ id }] = await ds.query('SELECT id FROM couriers ORDER BY id LIMIT 1');
        const { rows, total } = await walk(`courier_id=${id}`);
        expect(total).toBe(await count('EXISTS (SELECT 1 FROM delivery_tasks t WHERE t.issuance_id = i.id AND t.courier_id = $1 AND t.status = $2)', [id, TaskStatus.pending]));
        expect(total).toBeGreaterThan(0);
        for (const r of rows) expect(r.current_task).toMatchObject({ courier_id: id, status: TaskStatus.pending });
    });

    it('search, a partial street', async () => {
        const part = 'הרצל';
        const { rows, total } = await walk(`search=${encodeURIComponent(part)}`);
        expect(total).toBe(await count('(i.sap_number ILIKE $1 OR i.customer_name ILIKE $1 OR i.address_street ILIKE $1 OR i.address_city ILIKE $1)', [`%${part}%`]));
        expect(total).toBeGreaterThan(0);
        for (const r of rows) expect([r.sap_number, r.customer_name, r.address_street, r.address_city].some((v) => String(v).includes(part))).toBe(true);
    });

    it('a filter far past its end returns no rows and the filtered total', async () => {
        const total = await count('i.status = $1', [IssuanceStatus.assigned]);
        expect(Math.ceil(total / 15)).toBeGreaterThanOrEqual(2);
        expect(await list(`status=${IssuanceStatus.assigned}&page=50`)).toEqual({ rows: [], total, page: 50, page_size: 15 });
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('deleted rows', () => {
    it('never show on a page and are not in the total, through the status filter either', async () => {
        const deleted = (await ds.query('SELECT id FROM issuances WHERE deleted_at IS NOT NULL')).map((r) => +r.id);
        expect(deleted.length).toBeGreaterThan(0);
        const { ids, total } = await walk('');
        expect(total + deleted.length).toBe(30 + BULK);
        const seen = new Set(ids);
        for (const id of deleted) expect(seen.has(id)).toBe(false);
        expect((await list(`status=${IssuanceStatus.deleted}`)).total).toBe(0);
    });
});
