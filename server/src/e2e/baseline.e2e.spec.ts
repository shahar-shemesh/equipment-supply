import './setup-env';

import * as path from 'path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { entities } from '../entities';
import { Baseline1790000000000 } from '../migrations/1790000000000-Baseline';

//the baseline migration (docs/plans/baseline-migration.md) against two databases of its own, docker compose up -d first.
//<DB_NAME_TEST>_baseline is where every case builds its starting state; <DB_NAME_TEST>_baseline_ref is built once by
//synchronize from the entities and is the schema every case has to end with. one case per row of the plan's matrix.
//an older database is the current schema taken back by the downs of the later migrations: the plan's manual check
//compared that stand-in with the entities of the commit before OfflineSync (Implementation Notes there).
//"the same schema" is a snapshot of columns, constraints and indexes, sorted by name and blind to column order, plus
//the schema builder's pending sql; "the same data" is the row count and an md5 over the ordered rows of every table

const TEST_DB = process.env.DB_NAME_TEST || 'equipment_supply_test';
const DB = TEST_DB + '_baseline';
const REF = TEST_DB + '_baseline_ref';
const connection = {
    type: 'postgres' as const,
    host: process.env.DB_HOST || 'localhost',
    port: +(process.env.DB_PORT || 5433),
    username: process.env.DB_USER || 'equipment',
    password: process.env.DB_PASSWORD || 'equipment',
    entities,
};
const options = { ...connection, database: DB };

const BASELINE = 'Baseline1790000000000';
const BASE_TABLES = ['couriers', 'delivery_attempt_items', 'delivery_attempts', 'delivery_tasks', 'issuance_items', 'issuances', 'users'];
const ALL_TABLES = ['audit_log', 'couriers', 'delivery_attempt_items', 'delivery_attempts', 'delivery_conflicts', 'delivery_operations', 'delivery_tasks', 'issuance_items', 'issuances', 'users', 'xml_import_files', 'xml_outbox'];
const XML_OUTBOX = 1791300000000;

let ds: DataSource;
let reference: Snapshot;
//what synchronize still reports on its own fresh schema: the DROP / SET DEFAULT pair typeorm re-issues on every run for
//a uuid id with gen_random_uuid() (migrations.e2e.spec tells it for xml_outbox.id; xml_import_files.id has the same
//default and gets the same pair). a database built right shows that and nothing else
let quirk: string[];
//every migration, sorted by the timestamp in its name the way typeorm sorts them
let migrations: { name: string; timestamp: number; instance: any }[];

type Snapshot = { columns: any[]; constraints: any[]; indexes: any[] };

async function ensureDatabase(name: string) {
    const client = new Client({ host: connection.host, port: connection.port, user: connection.username, password: connection.password, database: 'postgres' });
    await client.connect();
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!exists.rowCount) await client.query(`CREATE DATABASE "${name}"`);
    await client.end();
}

beforeAll(async () => {
    await ensureDatabase(DB);
    await ensureDatabase(REF);
    const ref = new DataSource({ ...connection, database: REF, dropSchema: true, synchronize: true });
    try {
        await ref.initialize();
        reference = await snapshot(ref);
        quirk = await pendingSchemaChanges(ref);
    } finally {
        if (ref.isInitialized) await ref.destroy();
    }
    //synchronize off, like data-source.ts: the connection migration:run uses
    ds = new DataSource({ ...options, synchronize: false, migrations: [path.join(__dirname, '../migrations/*.ts')], migrationsTableName: 'migrations' });
    await ds.initialize();
    migrations = ds.migrations.map((instance: any) => ({ name: instance.name || instance.constructor.name, instance })).map((m) => ({ ...m, timestamp: +m.name.slice(-13) })).sort((a, b) => a.timestamp - b.timestamp);
});

afterAll(async () => {
    //a beforeAll that failed before the connection opened must not add a teardown error next to the real one
    if (ds?.isInitialized) await ds.destroy();
});

/*──────────────────────────────────────────────────────────────────────────*/

//an empty database (sync false) or today's schema from the entities with no migrations table, the LOCAL path (sync true)
async function reset(sync: boolean) {
    const fresh = new DataSource({ ...options, dropSchema: true, synchronize: sync });
    try {
        await fresh.initialize();
    } finally {
        if (fresh.isInitialized) await fresh.destroy();
    }
}

/*──────────────────────────────────────────────────────────────────────────*/

//the migrations table is the runner's, the reference has none
async function snapshot(db: DataSource): Promise<Snapshot> {
    const columns = await db.query(`SELECT table_name, column_name, data_type, udt_name, character_maximum_length, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name <> 'migrations' ORDER BY table_name, column_name`);
    const constraints = await db.query(`SELECT t.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = current_schema() AND t.relname <> 'migrations' ORDER BY t.relname, c.conname`);
    const indexes = await db.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename <> 'migrations' ORDER BY tablename, indexname`);
    return { columns, constraints, indexes };
}

/*──────────────────────────────────────────────────────────────────────────*/

async function pendingSchemaChanges(db: DataSource) {
    const sql = await db.driver.createSchemaBuilder().log();
    return sql.upQueries.map((q) => q.query);
}

/*──────────────────────────────────────────────────────────────────────────*/

async function tables(): Promise<string[]> {
    const rows = await ds.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`);
    return rows.map((r) => r.table_name).sort();
}

/*──────────────────────────────────────────────────────────────────────────*/

async function columnsByTable(): Promise<Record<string, string[]>> {
    const rows = await ds.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name <> 'migrations' ORDER BY table_name, ordinal_position`);
    const result: Record<string, string[]> = {};
    for (const r of rows) (result[r.table_name] ||= []).push(r.column_name);
    return result;
}

/*──────────────────────────────────────────────────────────────────────────*/

//per table the row count and an md5 over the rows ordered by id. with columns, only those columns of those tables: an
//upgrade adds columns and drops one, so the rows are compared on what both shapes have
async function checksums(columns?: Record<string, string[]>) {
    const result: Record<string, { rows: number; md5: string }> = {};
    const list = columns ? Object.keys(columns) : (await tables()).filter((t) => ALL_TABLES.includes(t));
    for (const table of list) {
        const row = columns ? `row(${columns[table].map((c) => `t."${c}"`).join(', ')})::text` : 't::text';
        const [r] = await ds.query(`SELECT count(*)::int AS rows, md5(coalesce(string_agg(${row}, E'\\n' ORDER BY t.id), '')) AS md5 FROM "${table}" t`);
        result[table] = r;
    }
    return result;
}

/*──────────────────────────────────────────────────────────────────────────*/

async function history(): Promise<{ timestamp: number; name: string }[]> {
    const rows = await ds.query(`SELECT timestamp, name FROM migrations ORDER BY id`);
    return rows.map((r) => ({ timestamp: +r.timestamp, name: r.name }));
}

/*──────────────────────────────────────────────────────────────────────────*/

//takes today's schema back to the state right after the migration with this timestamp (0: before every migration),
//newest down first. the class's down, not the runner: the migrations table stays out of it
async function downTo(timestamp: number) {
    const qr = ds.createQueryRunner();
    await qr.connect();
    try {
        for (const m of [...migrations].reverse()) {
            if (m.name !== BASELINE && m.timestamp > timestamp) await m.instance.down(qr);
        }
    } finally {
        await qr.release();
    }
}

/*──────────────────────────────────────────────────────────────────────────*/

//records the later migrations up to this timestamp as applied, the history of a database that ran them back then.
//typeorm's own runner on a list without the baseline: each one runs as a no-op over the objects it finds
async function record(upTo: number) {
    const classes = migrations.filter((m) => m.name !== BASELINE && m.timestamp <= upTo).map((m) => m.instance.constructor);
    const old = new DataSource({ ...options, synchronize: false, migrations: classes, migrationsTableName: 'migrations' });
    await old.initialize();
    try {
        return (await old.runMigrations({ transaction: 'all' })).map((m) => m.name);
    } finally {
        await old.destroy();
    }
}

/*──────────────────────────────────────────────────────────────────────────*/

//the rows a working database holds, in the shape it has: a table that is not there is skipped, a column that is not
//there is left out (users.password_hash before AuthMockIdentities, issuances.revision before OfflineSync...)
async function seedRows() {
    const columns = await columnsByTable();
    async function insert(table: string, row: Record<string, any>) {
        if (!columns[table]) return null;
        const keys = Object.keys(row).filter((k) => columns[table].includes(k));
        const [r] = await ds.query(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, keys.map((k) => row[k]));
        return r.id;
    }

    const userId = await insert('users', { username: 'baseline-courier', display_name: 'Baseline Courier', role: 'courier', password_hash: '$2a$08$notarealhash', email: 'courier@example.test' });
    const managerId = await insert('users', { username: 'baseline-manager', display_name: 'Baseline Manager', role: 'manager', password_hash: '$2a$08$notarealhasheither' });
    const courierId = await insert('couriers', { name: 'Baseline Courier', employee_id: 'E-9001', id_number: '123456782', phone: '0501234567', zones: 'Haifa,Akko', active: true, user_id: userId });
    await insert('couriers', { name: 'No Login Ltd', active: true });
    const issuanceId = await insert('issuances', { sap_number: '9000000001', number_prefix: 'D', status: 'partially_delivered', priority: 'urgent', customer_name: 'Baseline Customer', customer_phone: '0521234567', address_street: 'Herzl 1', address_city: 'Haifa', delivery_date: '2026-10-26', notes: 'two lines', revision: 3 });
    const itemA = await insert('issuance_items', { issuance_id: issuanceId, line_no: 1, product_name: 'Radio', catalog_number: 'CAT-1', serial_number: 'SN-1' });
    const itemB = await insert('issuance_items', { issuance_id: issuanceId, line_no: 2, product_name: 'Antenna', catalog_number: 'CAT-2', quantity: 2 });
    const taskId = await insert('delivery_tasks', { issuance_id: issuanceId, courier_id: courierId, status: 'done', scheduled_date: '2026-10-26', assigned_by: managerId, closed_at: '2026-10-26T10:00:00Z' });
    const attemptId = await insert('delivery_attempts', { task_id: taskId, outcome: 'partially_delivered', recipient_type: 'customer', recipient_name: 'Baseline Customer', signature_png: 'data:image/png;base64,iVBORw0KGgo=', client_reported_at: '2026-10-26T09:58:00Z' });
    await insert('delivery_attempt_items', { attempt_id: attemptId, item_id: itemA, delivered: true });
    await insert('delivery_attempt_items', { attempt_id: attemptId, item_id: itemB, delivered: false, reason: 'nobody_home', reason_details: 'no answer at the door' });

    //the later tables, where the shape has them
    await insert('delivery_operations', { user_id: userId, courier_id: courierId, operation_id: 'op-baseline-1', task_id: taskId, attempt_id: attemptId, payload_hash: 'a'.repeat(64), result: JSON.stringify({ attempt_id: attemptId, outcome: 'partially_delivered' }) });
    await insert('delivery_conflicts', { user_id: userId, courier_id: courierId, operation_id: 'op-baseline-2', task_id: taskId, issuance_id: issuanceId, submitted_revision: 2, recipient_type: 'customer', recipient_name: 'Baseline Customer', items: JSON.stringify([{ item_id: itemA, delivered: true }]), signature_png: 'data:image/png;base64,iVBORw0KGgo=', payload_hash: 'b'.repeat(64), rejection_code: 'task_closed', observed: JSON.stringify({ task_status: 'done' }) });
    await insert('audit_log', { actor_type: 'user', actor_user_id: userId, actor_username: 'baseline-courier', actor_role: 'courier', action: 'delivery.report', entity_type: 'delivery_task', entity_id: taskId, issuance_id: issuanceId, details: JSON.stringify({ task_id: taskId, attempt_id: attemptId }) });
    await insert('xml_outbox', { issuance_id: issuanceId, sequence: 1, previous_status: 'assigned', new_status: 'partially_delivered', trigger: 'delivery.report', payload: JSON.stringify({ sap_number: '9000000001' }), occurred_at: '2026-10-26T10:00:00Z' });
    await insert('xml_import_files', { content_sha256: 'c'.repeat(64), document_id: 'DOC-BASELINE-1', file_name: 'issuances-1.xml', size_bytes: 1234, status: 'completed', inserted: 1 });
}

/*──────────────────────────────────────────────────────────────────────────*/

//the class's up on a query runner that keeps every statement it is sent, the createTable style helpers included (they
//call this.query too)
async function baselineStatements() {
    const qr = ds.createQueryRunner();
    await qr.connect();
    const sent: string[] = [];
    const query = qr.query.bind(qr);
    qr.query = ((sql: string, ...rest: any[]) => {
        sent.push(sql);
        return query(sql, ...rest);
    }) as any;
    try {
        await new Baseline1790000000000().up(qr);
    } finally {
        await qr.release();
    }
    return sent;
}

/*──────────────────────────────────────────────────────────────────────────*/

function namesUpTo(timestamp = Infinity, from = 0) {
    return migrations.filter((m) => m.timestamp > from && m.timestamp <= timestamp).map((m) => m.name);
}

/*──────────────────────────────────────────────────────────────────────────*/

async function expectReferenceSchema() {
    expect(await snapshot(ds)).toEqual(reference);
    expect(await pendingSchemaChanges(ds)).toEqual(quirk);
}

describe('the reference', () => {
    it('is the entities\' schema, and synchronize leaves nothing on it but the uuid default quirk', () => {
        expect([...new Set(reference.columns.map((c) => c.table_name))].sort()).toEqual(ALL_TABLES);
        expect(quirk.length).toBeGreaterThan(0);
        for (const q of quirk) expect(q).toMatch(/^ALTER TABLE "(xml_outbox|xml_import_files)" ALTER COLUMN "id" (DROP DEFAULT|SET DEFAULT gen_random_uuid\(\))$/);
        expect(migrations[0].name).toBe(BASELINE);
    });
});

describe('Baseline1790000000000 on an empty database', () => {
    it('builds the whole schema with the ten after it, records eleven in timestamp order, and runs nothing the second time', async () => {
        await reset(false);
        expect(await tables()).toEqual([]);

        //transaction 'all' is what the typeorm cli (npm run migration:run) does by default
        const ran = await ds.runMigrations({ transaction: 'all' });
        expect(ran.map((m) => m.name)).toEqual(namesUpTo());
        expect(await history()).toEqual(migrations.map(({ timestamp, name }) => ({ timestamp, name })));
        expect(await tables()).toEqual([...ALL_TABLES, 'migrations'].sort());
        await expectReferenceSchema();

        //second run: nothing pending, nothing executed
        expect(await ds.showMigrations()).toBe(false);
        expect(await ds.runMigrations({ transaction: 'all' })).toEqual([]);
        expect(await history()).toHaveLength(migrations.length);
        await expectReferenceSchema();
    });
});

describe('Baseline1790000000000 on a database that already holds the base tables', () => {
    //the three shapes an existing database can have. the class itself, outside the runner: the one statement it sends
    //is the existence check, the schema and the rows are the same afterwards
    it.each([
        ['today\'s schema', Infinity],
        ['the schema right after XmlOutbox', XML_OUTBOX],
        ['the schema before every migration', 0],
    ])('executes nothing but its check on %s', async (_label, upTo) => {
        await reset(true);
        if (upTo !== Infinity) await downTo(upTo);
        await seedRows();
        const before = { schema: await snapshot(ds), data: await checksums() };

        const sent = await baselineStatements();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatch(/^SELECT c\.relname AS name FROM pg_class c JOIN pg_namespace n ON n\.oid = c\.relnamespace WHERE n\.nspname = current_schema\(\)/);

        expect(await snapshot(ds)).toEqual(before.schema);
        expect(await checksums()).toEqual(before.data);
    });

    it('a current database whose history has the ten: runs the baseline alone, changes no schema and no row, and gains one history row', async () => {
        await reset(true);
        expect(await record(Infinity)).toEqual(namesUpTo().filter((n) => n !== BASELINE));
        await seedRows();
        const data = await checksums();
        await expectReferenceSchema();

        //typeorm 0.3.31 runs a pending migration older than the last applied one
        const ran = await ds.runMigrations({ transaction: 'all' });
        expect(ran.map((m) => m.name)).toEqual([BASELINE]);

        await expectReferenceSchema();
        expect(await checksums()).toEqual(data);
        const rows = await history();
        expect(rows).toHaveLength(migrations.length);
        expect(rows[rows.length - 1].name).toBe(BASELINE);
        expect(await ds.runMigrations()).toEqual([]);
    });

    it('a current database: migration:revert meets the baseline first, takes only its row back with no schema or row change, then reverts the newest migration as before', async () => {
        await reset(true);
        await record(Infinity);
        await seedRows();
        await ds.runMigrations({ transaction: 'all' });
        const data = await checksums();

        //the baseline is the last row of the history here, so it is what a revert takes. recorded over the ten, its down
        //executes nothing but the count of the other rows
        await ds.undoLastMigration({ transaction: 'all' });
        expect((await history()).map((h) => h.name)).toEqual(namesUpTo().filter((n) => n !== BASELINE));
        await expectReferenceSchema();
        expect(await checksums()).toEqual(data);

        //the next revert takes the newest migration, the next run records the baseline again (executing nothing) and
        //applies that one back
        const newest = migrations[migrations.length - 1].name;
        await ds.undoLastMigration({ transaction: 'all' });
        expect((await history()).map((h) => h.name)).not.toContain(newest);
        expect(await snapshot(ds)).not.toEqual(reference);
        const ran = await ds.runMigrations({ transaction: 'all' });
        expect(ran.map((m) => m.name)).toEqual([BASELINE, newest]);
        await expectReferenceSchema();
    });

    it('a LOCAL database built by synchronize, no migrations table: runs eleven and changes no schema and no row', async () => {
        await reset(true);
        await seedRows();
        const data = await checksums();
        expect(await tables()).not.toContain('migrations');

        const ran = await ds.runMigrations({ transaction: 'all' });
        expect(ran.map((m) => m.name)).toEqual(namesUpTo());

        await expectReferenceSchema();
        expect(await checksums()).toEqual(data);
        expect(await history()).toHaveLength(migrations.length);
    });

    it('a database right after XmlOutbox, the first seven recorded: the baseline executes nothing, the migrations after XmlOutbox upgrade it, the rows stay', async () => {
        await reset(true);
        await downTo(XML_OUTBOX);
        expect(await record(XML_OUTBOX)).toEqual(namesUpTo(XML_OUTBOX).filter((n) => n !== BASELINE));
        await seedRows();
        const columns = await columnsByTable();
        expect(columns.users).toContain('password_hash');
        expect(columns.xml_import_files).toBeUndefined();
        //AuthMockIdentities drops users.password_hash, the rows are compared on every other column
        const kept = { ...columns, users: columns.users.filter((c) => c !== 'password_hash') };
        const data = await checksums(kept);

        const ran = await ds.runMigrations({ transaction: 'all' });
        expect(ran.map((m) => m.name)).toEqual([BASELINE, ...namesUpTo(Infinity, XML_OUTBOX)]);

        await expectReferenceSchema();
        expect(await checksums(kept)).toEqual(data);
        //what AuthMockIdentities and XmlImportFiles define for the rows already there: no email, no import file
        expect(await ds.query(`SELECT username, email FROM users ORDER BY id`)).toEqual([{ username: 'baseline-courier', email: null }, { username: 'baseline-manager', email: null }]);
        expect(+(await ds.query(`SELECT count(*) AS n FROM xml_import_files`))[0].n).toBe(0);
        expect((await history()).map((h) => h.name)).toEqual([...namesUpTo(XML_OUTBOX).filter((n) => n !== BASELINE), BASELINE, ...namesUpTo(Infinity, XML_OUTBOX)]);

        //the baseline sits mid history here: migration:revert takes the three after it first, then its own row with no
        //change, and leaves the seven it found
        for (let i = 0; i < namesUpTo(Infinity, XML_OUTBOX).length; i++) await ds.undoLastMigration({ transaction: 'all' });
        const reverted = { schema: await snapshot(ds), data: await checksums() };
        await ds.undoLastMigration({ transaction: 'all' });
        expect((await history()).map((h) => h.name)).toEqual(namesUpTo(XML_OUTBOX).filter((n) => n !== BASELINE));
        expect(await snapshot(ds)).toEqual(reverted.schema);
        expect(await checksums()).toEqual(reverted.data);
    });

    it('a database from before every migration, no migrations table: runs eleven, the baseline executes nothing, the ten upgrade it, the rows stay', async () => {
        await reset(true);
        await downTo(0);
        await seedRows();
        const columns = await columnsByTable();
        expect(Object.keys(columns).sort()).toEqual(BASE_TABLES);
        expect(columns.issuances).not.toContain('revision');
        const kept = { ...columns, users: columns.users.filter((c) => c !== 'password_hash') };
        const data = await checksums(kept);

        const ran = await ds.runMigrations({ transaction: 'all' });
        expect(ran.map((m) => m.name)).toEqual(namesUpTo());

        await expectReferenceSchema();
        expect(await checksums(kept)).toEqual(data);
        //what the ten define for the rows already there
        expect(await ds.query(`SELECT revision, delivered_by_user_id FROM issuances`)).toEqual([{ revision: 1, delivered_by_user_id: null }]);
        expect(await ds.query(`SELECT count(*)::int AS n FROM issuance_items WHERE removed_at IS NULL`)).toEqual([{ n: 2 }]);
        expect(await ds.query(`SELECT client_reported_at FROM delivery_attempts`)).toEqual([{ client_reported_at: null }]);
        expect(await ds.query(`SELECT email FROM users ORDER BY id`)).toEqual([{ email: null }, { email: null }]);
        for (const table of ALL_TABLES.filter((t) => !BASE_TABLES.includes(t))) {
            expect([table, +(await ds.query(`SELECT count(*) AS n FROM "${table}"`))[0].n]).toEqual([table, 0]);
        }
    });
});

describe('Baseline1790000000000 on a database with part of the schema', () => {
    it('reads some of the base tables as an existing database: executes nothing, and the first migration that needs a missing one fails as it did before the baseline', async () => {
        await reset(false);
        await ds.query(`CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "username" character varying NOT NULL)`);
        await ds.query(`CREATE TABLE "couriers" ("id" SERIAL PRIMARY KEY, "name" character varying NOT NULL)`);

        //a later migration may rename or drop a base table, and this file cannot follow it: any base table is enough
        expect(await baselineStatements()).toHaveLength(1);
        expect(await tables()).toEqual(['couriers', 'users']);

        await expect(ds.runMigrations({ transaction: 'all' })).rejects.toThrow('relation "issuances" does not exist');
        //the runner creates its own table before the transaction; the rollback leaves it empty
        expect(await tables()).toEqual(['couriers', 'migrations', 'users']);
        expect(await history()).toEqual([]);
    });

    it('a view named like a base table does not count, a database with only that view is built as an empty one', async () => {
        await reset(false);
        await ds.query(`CREATE VIEW "users" AS SELECT 1 AS id`);

        //the view is in the way of CREATE TABLE "users": the whole run rolls back, nothing is half built
        await expect(ds.runMigrations({ transaction: 'all' })).rejects.toThrow('relation "users" already exists');
        expect(await tables()).toEqual(['migrations', 'users']);
        expect(await ds.query(`SELECT table_type FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'users'`)).toEqual([{ table_type: 'VIEW' }]);
        expect(await history()).toEqual([]);
    });

    it('refuses a database that holds only tables of the later migrations, names them, and creates nothing', async () => {
        await reset(false);
        await ds.query(`CREATE TABLE "audit_log" ("id" SERIAL PRIMARY KEY)`);
        await ds.query(`CREATE TABLE "xml_outbox" ("id" uuid PRIMARY KEY)`);

        await expect(ds.runMigrations({ transaction: 'all' })).rejects.toThrow(`present: audit_log, xml_outbox; missing base tables: users, couriers, issuances, issuance_items, delivery_tasks, delivery_attempts, delivery_attempt_items. nothing was created`);
        expect(await tables()).toEqual(['audit_log', 'migrations', 'xml_outbox']);
        expect(await history()).toEqual([]);
    });
});

describe('Baseline1790000000000 down', () => {
    it('is refused on a database it built, with the reason and the way to start over, and drops nothing', async () => {
        //the baseline alone, so it is the last applied migration
        await reset(false);
        const only = new DataSource({ ...options, synchronize: false, migrations: [Baseline1790000000000], migrationsTableName: 'migrations' });
        await only.initialize();
        try {
            expect((await only.runMigrations()).map((m) => m.name)).toEqual([BASELINE]);
            await expect(only.undoLastMigration()).rejects.toThrow(/^Baseline1790000000000 cannot be reverted on a database it built: its down would drop every table with the data\. to start over, drop the database and run migration:run on the empty one$/);
            expect(await only.query(`SELECT name FROM migrations`)).toEqual([{ name: BASELINE }]);
        } finally {
            await only.destroy();
        }
        expect(await tables()).toEqual([...ALL_TABLES, 'migrations'].sort());
    });
});
