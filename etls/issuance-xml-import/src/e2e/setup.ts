import 'reflect-metadata';

import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Client, Pool } from 'pg';
import { DataSource } from 'typeorm';

import { entities } from '../../../../server/src/entities';
import { DEFAULT_DB_PORT } from '../config/env';
import { transactionOn } from '../repositories/db';
import { importFilesRepository } from '../repositories/import-files.repository';
import { issuancesRepository } from '../repositories/issuances.repository';
import { ensureDirs } from '../services/files';
import type { PipelineDeps } from '../services/pipeline';
import { createLogger } from '../utils/logger';

//the database of the e2e specs: equipment_supply_etl_test, created from the postgres database when missing and
//rebuilt from the server's entities (synchronize on a dropped schema) once per spec file, so the etl is always tested
//against the exact current schema. typeorm is a devDependency for this file alone: the entities resolve the server's
//copy for their decorators, the DataSource is this package's copy, and the two meet on the metadata storage typeorm
//keeps on globalThis (vitest.config.ts transpiles the entities with decorator metadata). never equipment_supply, never
//the server's own test database: both are refused by name

export const TEST_DB = (process.env.DB_NAME_TEST || 'equipment_supply_etl_test').trim();
if (TEST_DB === 'equipment_supply' || TEST_DB === 'equipment_supply_test' || !/^[a-z0-9_]+$/.test(TEST_DB)) {
  throw new Error(`DB_NAME_TEST must name a database of the etl's own, got "${TEST_DB}"`);
}

export const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: +(process.env.DB_PORT || DEFAULT_DB_PORT),
  user: process.env.DB_USER || 'equipment',
  password: process.env.DB_PASSWORD || 'equipment',
  database: TEST_DB,
};

/*──────────────────────────────────────────────────────────────────────────*/

export async function createTestSchema() {
  const client = new Client({ ...dbConfig, database: 'postgres' });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (!exists.rowCount) await client.query(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await client.end();
  }

  const ds = new DataSource({ type: 'postgres', host: dbConfig.host, port: dbConfig.port, username: dbConfig.user, password: dbConfig.password, database: TEST_DB, entities, dropSchema: true, synchronize: true });
  try {
    await ds.initialize();
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
}

export function testPool() {
  return new Pool({ ...dbConfig, max: 4 });
}

//every table of the schema back to empty with its sequences, between tests
export async function truncateAll(pool: Pool) {
  const { rows } = await pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`);
  if (!rows.length) return;
  await pool.query(`TRUNCATE TABLE ${rows.map((r) => `"${r.table_name}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

/*──────────────────────────────────────────────────────────────────────────*/

//the three directories of one spec file under the os temp dir, and the real pipeline on them
export async function tempDirs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'etl-e2e-'));
  const dirs = { input: path.join(root, 'input'), archive: path.join(root, 'archive'), error: path.join(root, 'error') };
  await ensureDirs(Object.values(dirs));
  return { root, dirs };
}

export function makeDeps(pool: Pool, dirs: PipelineDeps['config']['dirs'], overrides: Partial<Omit<PipelineDeps, 'config'>> & { config?: Partial<PipelineDeps['config']> } = {}): PipelineDeps {
  const { config, ...rest } = overrides;
  return {
    config: { dirs, batchSize: 100, minFileAgeMs: 0, maxFileBytes: 5 * 1024 * 1024, leaseMs: 60000, maxAttempts: 10, instanceId: 'etl-test', ...config },
    db: pool,
    transaction: transactionOn(pool),
    importFiles: importFilesRepository,
    issuances: issuancesRepository,
    logger: createLogger('warn', {}, () => undefined),
    ...rest,
  };
}

/*──────────────────────────────────────────────────────────────────────────*/

//a document of the provisional contract from plain objects, for the specs. an undefined field is left out
export type DocItem = { line: number; product: string; catalog?: string; station?: string; serial?: string; qty?: number };
export type DocIssuance = {
  sap: string;
  prefix?: string;
  priority?: string;
  date?: string;
  customer: { name: string; id?: string; phone?: string };
  address: { street: string; building?: string; city: string };
  notes?: string;
  items: DocItem[];
  extra?: string; //raw xml appended inside the issuance, for the refusals
};

export function xmlDocument(doc: { id: string; at?: string; issuances: DocIssuance[] }) {
  const leaf = (name: string, value: string | number | undefined) => (value === undefined ? '' : `<${name}>${escape(String(value))}</${name}>`);
  const issuances = doc.issuances
    .map(
      (i) =>
        `<Issuance>${leaf('SapNumber', i.sap)}${leaf('NumberPrefix', i.prefix)}${leaf('Priority', i.priority)}${leaf('DeliveryDate', i.date)}` +
        `<Customer>${leaf('Name', i.customer.name)}${leaf('IdNumber', i.customer.id)}${leaf('Phone', i.customer.phone)}</Customer>` +
        `<Address>${leaf('Street', i.address.street)}${leaf('Building', i.address.building)}${leaf('City', i.address.city)}</Address>${leaf('Notes', i.notes)}` +
        `<Items>${i.items.map((it) => `<Item>${leaf('LineNo', it.line)}${leaf('ProductName', it.product)}${leaf('CatalogNumber', it.catalog)}${leaf('StationNumber', it.station)}${leaf('SerialNumber', it.serial)}${leaf('Quantity', it.qty)}</Item>`).join('')}</Items>` +
        `${i.extra ?? ''}</Issuance>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<IssuanceImport xmlns="urn:equipment-supply:issuance-import" schemaVersion="0.1-provisional">\n<DocumentId>${doc.id}</DocumentId>\n<GeneratedAt>${doc.at ?? '2026-10-25T09:30:00Z'}</GeneratedAt>\n<Issuances>\n${issuances}\n</Issuances>\n</IssuanceImport>\n`;
}

function escape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
