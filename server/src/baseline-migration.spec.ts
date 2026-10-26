import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

//the baseline migration is frozen (docs/domain.md, Schema upgrade). every database that recorded it holds the schema it
//built, or had its tables already and skipped it, and nothing would ever run an edited version on those: an edit only
//reaches the next empty database. a schema change is a new migration. this spec sits here and not in migrations/
//because both migration globs (data-source.ts, the e2e harnesses) would load a file from there

const DIR = path.join(__dirname, 'migrations');
const FILE = path.join(DIR, '1790000000000-Baseline.ts');
//sha-256 of the file as it landed, line endings as lf
const PINNED = '161b9f1b7c2946330843d41a483e5d111885a266b6d30a64563976c9288da1ee';

describe('Baseline1790000000000', () => {
    it('is the file that landed, byte for byte', () => {
        //git's autocrlf checks it out with crlf on windows, the content is the same
        const sha = createHash('sha256').update(fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
        if (sha !== PINNED) {
            throw new Error(`server/src/migrations/1790000000000-Baseline.ts changed (sha-256 ${sha}, pinned ${PINNED}). it is frozen: revert the edit and write a new migration for the schema change instead`);
        }
    });

    it('is the oldest migration, so an empty database gets its tables before anything alters them', () => {
        //the timestamp typeorm sorts by: the last 13 characters of the migration's name (MigrationExecutor.getMigrations)
        const migrations = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts')).flatMap((f) => {
            const exported = Object.values(require(path.join(DIR, f))).filter((v) => typeof v === 'function') as any[];
            return exported.map((c) => new c().name as string);
        });
        const stamps = migrations.map((name) => +name.slice(-13));
        expect(migrations).toContain('Baseline1790000000000');
        expect(Math.min(...stamps)).toBe(1790000000000);
        expect(stamps.filter((s) => s === 1790000000000)).toHaveLength(1);
        expect(migrations.length).toBeGreaterThan(1);
    });
});
