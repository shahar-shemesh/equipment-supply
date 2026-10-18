import './setup-env';

import * as path from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { entities } from '../entities';
import { AuthMockIdentities1791400000000 } from '../migrations/1791400000000-AuthMockIdentities';

//the migrations against a database of their own (docker compose up -d first). the base tables have no migration (the
//first deployment ran synchronize, docs/domain.md), so the harness builds the current schema from the entities, puts
//the users table back in its previous shape with the last migration's down, inserts a row as an upgraded database
//would hold one, and then runs the migrations the way migration:run does: the row must survive, the schema must match
//the entities exactly (what synchronize would still change is the diff), every earlier migration must be a no-op on
//a schema that already holds its objects, and down must take the step back

const DB = (process.env.DB_NAME_TEST || 'equipment_supply_test') + '_migrations';
const options = {
    type: 'postgres' as const,
    host: process.env.DB_HOST || 'localhost',
    port: +(process.env.DB_PORT || 5433),
    username: process.env.DB_USER || 'equipment',
    password: process.env.DB_PASSWORD || 'equipment',
    database: DB,
    entities,
};

let ds: DataSource;
//what synchronize reports on its own freshly built schema. not empty: typeorm re-issues the DROP / SET DEFAULT pair
//for xml_outbox.id (gen_random_uuid()) on every run, a quirk of its uuid default comparison, so "the migrations and the
//entities agree" means "nothing beyond that baseline"
let baseline: string[];

async function ensureDatabase() {
    const client = new Client({ host: options.host, port: options.port, user: options.username, password: options.password, database: 'postgres' });
    await client.connect();
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
    if (!exists.rowCount) await client.query(`CREATE DATABASE "${DB}"`);
    await client.end();
}

beforeAll(async () => {
    await ensureDatabase();
    //a clean schema from the entities, then the connection the migrations run on: synchronize off, like data-source.ts
    const fresh = new DataSource({ ...options, dropSchema: true, synchronize: true });
    try {
        await fresh.initialize();
    } finally {
        if (fresh.isInitialized) await fresh.destroy();
    }
    ds = new DataSource({ ...options, synchronize: false, migrations: [path.join(__dirname, '../migrations/*.ts')], migrationsTableName: 'migrations' });
    await ds.initialize();
    baseline = await pendingSchemaChanges();
});

afterAll(async () => {
    await ds?.destroy();
});

async function columnsOfUsers() {
    const rows: { column_name: string; is_nullable: string; column_default: string | null }[] = await ds.query(`SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' ORDER BY column_name`);
    return Object.fromEntries(rows.map((r) => [r.column_name, { nullable: r.is_nullable === 'YES', def: r.column_default }]));
}

//what synchronize would still run against this schema: the baseline and nothing else when the migrations and the
//entities agree
async function pendingSchemaChanges() {
    const sql = await ds.driver.createSchemaBuilder().log();
    return sql.upQueries.map((q) => q.query);
}

//one case, in order: the state of each step is the next step's input. the last migration is the one under test; when a
//later one arrives this case moves to a down of its own and the newcomer gets the "last" seat
describe('AuthMockIdentities1791400000000', () => {
    it('upgrades a users table of the previous version with its rows to the exact shape of the entity, is a no-op the second time, and down takes the step back', async () => {
        //the loaded list is not in timestamp order, the runner sorts by the number at the end of the name
        const byTime = ds.migrations.map((m) => (m as any).name ?? m.constructor.name).sort((a, b) => +a.match(/\d+$/)[0] - +b.match(/\d+$/)[0]);
        expect(byTime[byTime.length - 1]).toBe('AuthMockIdentities1791400000000');

        //the previous shape: password_hash not null, no email. down is the one place that knows it
        const qr = ds.createQueryRunner();
        await qr.connect();
        await new AuthMockIdentities1791400000000().down(qr);
        await qr.release();
        expect(Object.keys(await columnsOfUsers())).toEqual(['created_at', 'display_name', 'id', 'password_hash', 'role', 'username']);
        await ds.query(`INSERT INTO users (username, password_hash, display_name, role) VALUES ('old-manager', '$2a$08$notarealhash', 'Old Manager', 'manager')`);

        //transaction 'all' is what the typeorm cli (npm run migration:run) does by default
        const ran = await ds.runMigrations({ transaction: 'all' });
        expect(ran.map((m) => m.name)).toContain('AuthMockIdentities1791400000000');
        expect(ran).toHaveLength(ds.migrations.length);

        const columns = await columnsOfUsers();
        expect(columns.password_hash).toBeUndefined();
        expect(columns.email).toEqual({ nullable: true, def: null });
        expect(await ds.query(`SELECT username, display_name, role, email FROM users`)).toEqual([{ username: 'old-manager', display_name: 'Old Manager', role: 'manager', email: null }]);
        expect(await pendingSchemaChanges()).toEqual(baseline);

        //applied once: nothing pending, and the table records every one
        expect(await ds.showMigrations()).toBe(false);
        expect(await ds.runMigrations()).toEqual([]);

        //down restores the previous shape with the rows, up applies again
        await ds.undoLastMigration({ transaction: 'all' });
        const back = await columnsOfUsers();
        expect(back.email).toBeUndefined();
        expect(back.password_hash).toEqual({ nullable: false, def: "''::character varying" });
        expect(await ds.query(`SELECT username, password_hash FROM users`)).toEqual([{ username: 'old-manager', password_hash: '' }]);
        //and synchronize would now want the entity's shape back: the two are not in step until up runs again
        expect(await pendingSchemaChanges()).not.toEqual(baseline);
        expect(await ds.showMigrations()).toBe(true);

        const again = await ds.runMigrations({ transaction: 'all' });
        expect(again.map((m) => m.name)).toEqual(['AuthMockIdentities1791400000000']);
        expect((await columnsOfUsers()).password_hash).toBeUndefined();
        expect(await pendingSchemaChanges()).toEqual(baseline);
    });
});
