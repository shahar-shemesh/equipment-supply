//one exception to "nothing is mocked": fs.link is wrapped so one test can fail the final link after the body is on
//disk. the wrapper calls the real link unless a test says otherwise
jest.mock('node:fs/promises', () => {
    const actual = jest.requireActual('node:fs/promises');
    return { ...actual, link: jest.fn((...args: any[]) => actual.link(...args)) };
});

import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalXmlStorageService, categorizeFs, resolveKey } from './local-xml-storage.service';
import { StorageError } from './xml-storage';

//the local backend on a real temporary directory per test: the two calls, the taken key in each of its shapes, five
//puts at once, the sidecar orphans, the traversal and the error categories. nothing is mocked, the filesystem is the
//thing under test

const EVENT = 'a0d17000-0000-4000-8000-000000000001';
const OTHER = 'a0d17000-0000-4000-8000-000000000002';
const KEY = `issuance-status-changes/2026/10/14/issuance_12_${EVENT}.xml`;
const BODY = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><x>שלום</x>', 'utf8');

function sha(bytes: Buffer) {
    return createHash('sha256').update(bytes).digest('hex');
}

function metadata(over: Partial<Record<string, string>> = {}) {
    return { 'event-id': EVENT, 'issuance-id': '12', sequence: '1', 'content-sha256': sha(BODY), ...over } as any;
}

let dir: string;
let svc: LocalXmlStorageService;

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'xml-export-'));
    svc = new LocalXmlStorageService(dir);
});

afterEach(async () => {
    (link as unknown as jest.Mock).mockClear();
    await rm(dir, { recursive: true, force: true });
});

//every name in the directory tree, relative, with forward slashes, sorted
async function tree(root = dir): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) out.push(...(await tree(full)));
        else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
    return out.sort();
}

async function category(p: Promise<unknown>) {
    try {
        await p;
        return 'resolved';
    } catch (e) {
        expect(e).toBeInstanceOf(StorageError);
        return `${(e as StorageError).category}${(e as StorageError).config ? ' config' : ''}`;
    }
}

/*──────────────────────────────────────────────────────────────────────────*/

describe('putIfAbsent', () => {
    it('creates the day folder, writes the xml byte for byte and the sidecar next to it, and leaves no temporary file', async () => {
        await svc.putIfAbsent(KEY, BODY, metadata());
        expect(await tree()).toEqual([KEY, `${KEY}.meta.json`]);
        expect(await readFile(path.join(dir, KEY))).toEqual(BODY);
        expect(JSON.parse(await readFile(path.join(dir, `${KEY}.meta.json`), 'utf8'))).toEqual(metadata());
    });

    it('the same event again is a precondition, and the head gives the event id of the sidecar with the sha of the bytes', async () => {
        await svc.putIfAbsent(KEY, BODY, metadata());
        await expect(svc.putIfAbsent(KEY, BODY, metadata())).rejects.toMatchObject({ category: 'precondition', config: false });
        expect(await tree()).toEqual([KEY, `${KEY}.meta.json`]);
        expect(await svc.head(KEY)).toEqual({ metadata: metadata() });
    });

    it('other bytes under the key are a precondition, the stored bytes stay and the head reports their sha', async () => {
        await svc.putIfAbsent(KEY, BODY, metadata());
        const other = Buffer.from('<y/>', 'utf8');
        await expect(svc.putIfAbsent(KEY, other, metadata({ 'event-id': OTHER, 'content-sha256': sha(other) }))).rejects.toMatchObject({ category: 'precondition' });
        expect(await readFile(path.join(dir, KEY))).toEqual(BODY);
        expect(await tree()).toEqual([KEY, `${KEY}.meta.json`]);
        expect((await svc.head(KEY))?.metadata).toMatchObject({ 'event-id': EVENT, 'content-sha256': sha(BODY) });
    });

    it('five puts of one key at once: one resolves, four are preconditions, one file, no temporary name', async () => {
        const results = await Promise.allSettled(Array.from({ length: 5 }, () => svc.putIfAbsent(KEY, BODY, metadata())));
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(rejected).toHaveLength(4);
        for (const r of rejected) expect(r.reason).toMatchObject({ category: 'precondition' });
        expect(await tree()).toEqual([KEY, `${KEY}.meta.json`]);
        expect(await readFile(path.join(dir, KEY))).toEqual(BODY);
    });

    it('a sidecar of this very event with no xml next to it is our own crashed attempt: the put goes on', async () => {
        await mkdir(path.dirname(path.join(dir, KEY)), { recursive: true });
        await writeFile(path.join(dir, `${KEY}.meta.json`), JSON.stringify(metadata({ 'content-sha256': 'stale' })));
        await svc.putIfAbsent(KEY, BODY, metadata());
        expect(await tree()).toEqual([KEY, `${KEY}.meta.json`]);
        expect(await readFile(path.join(dir, KEY))).toEqual(BODY);
        //the sidecar of the crashed attempt stays, the head recomputes the sha from the bytes anyway
        expect(await svc.head(KEY)).toEqual({ metadata: metadata() });
    });

    it('a sidecar of another event with no xml is a foreign claim on the key: permanent key_collision, nothing written, and the head says null', async () => {
        await mkdir(path.dirname(path.join(dir, KEY)), { recursive: true });
        await writeFile(path.join(dir, `${KEY}.meta.json`), JSON.stringify(metadata({ 'event-id': OTHER })));
        await expect(svc.putIfAbsent(KEY, BODY, metadata())).rejects.toMatchObject({ category: 'permanent', message: expect.stringMatching(new RegExp(`^key_collision: .*${OTHER}`)) });
        expect(await tree()).toEqual([`${KEY}.meta.json`]);
        expect(await svc.head(KEY)).toBeNull();
    });

    it('a day folder that exists as a plain file is a transient config error, not a taken key', async () => {
        const day = path.dirname(path.join(dir, KEY));
        await mkdir(path.dirname(day), { recursive: true });
        await writeFile(day, 'not a folder');
        expect(await category(svc.putIfAbsent(KEY, BODY, metadata()))).toBe('transient config');
        expect(await readFile(day, 'utf8')).toBe('not a folder');
    });

    it('a put that dies after the body is on disk never shows a final name: the bytes were complete under the temporary name, the link failure is transient, nothing stays but our sidecar', async () => {
        const actual = jest.requireActual('node:fs/promises');
        const seen: { finalExisted: boolean; tmpBytes: Buffer | null } = { finalExisted: true, tmpBytes: null };
        (link as unknown as jest.Mock).mockImplementation(async (from: string, to: string) => {
            if (!to.endsWith('.xml')) return actual.link(from, to);
            //the moment before the document gets its name: the name is free and the temporary holds every byte
            seen.finalExisted = await actual.stat(to).then(() => true, () => false);
            seen.tmpBytes = await actual.readFile(from);
            throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        });
        expect(await category(svc.putIfAbsent(KEY, BODY, metadata()))).toBe('transient');
        expect(seen.finalExisted).toBe(false);
        expect(seen.tmpBytes).toEqual(BODY);
        expect(await tree()).toEqual([`${KEY}.meta.json`]); //the sidecar of a crashed attempt of this event, no document, no .tmp
        expect(await svc.head(KEY)).toBeNull();
        //the next attempt continues from the orphan sidecar and the document appears whole
        (link as unknown as jest.Mock).mockImplementation((...args: any[]) => actual.link(...args));
        await svc.putIfAbsent(KEY, BODY, metadata());
        expect(await readFile(path.join(dir, KEY))).toEqual(BODY);
    });

    it('temporary names older than ten minutes in the folder are swept by a put, fresh ones are left alone', async () => {
        const day = path.dirname(path.join(dir, KEY));
        await mkdir(day, { recursive: true });
        const stale = path.join(day, `issuance_1_${OTHER}.xml.${OTHER}.tmp`);
        const fresh = path.join(day, `issuance_1_${OTHER}.xml.${EVENT}.tmp`);
        await writeFile(stale, 'partial');
        await writeFile(fresh, 'in flight');
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        await utimes(stale, hourAgo, hourAgo);
        await svc.putIfAbsent(KEY, BODY, metadata());
        expect(await tree()).toEqual([KEY, `${KEY}.meta.json`, path.relative(dir, fresh).split(path.sep).join('/')].sort());
    });

    it('a document copied in by hand gets no sidecar: precondition, and the head has the sha but no event id', async () => {
        await mkdir(path.dirname(path.join(dir, KEY)), { recursive: true });
        await writeFile(path.join(dir, KEY), BODY);
        await expect(svc.putIfAbsent(KEY, BODY, metadata())).rejects.toMatchObject({ category: 'precondition' });
        expect(await tree()).toEqual([KEY]);
        expect(await svc.head(KEY)).toEqual({ metadata: { 'content-sha256': sha(BODY) } });
    });

    it('a key that resolves outside the directory is permanent and writes nothing', async () => {
        for (const bad of ['../issuance_1.xml', 'a/../../issuance_1.xml', path.join(os.tmpdir(), 'issuance_1.xml'), '/issuance_1.xml', '', '.', 'a/..']) {
            await expect(svc.putIfAbsent(bad, BODY, metadata())).rejects.toMatchObject({ category: 'permanent' });
        }
        expect(await tree()).toEqual([]);
    });

    it('a root that is a file is a transient config error', async () => {
        const file = path.join(dir, 'root');
        await writeFile(file, '');
        const onFile = new LocalXmlStorageService(file);
        expect(await category(onFile.putIfAbsent(KEY, BODY, metadata()))).toBe('transient config');
        expect(await category(onFile.head(KEY))).toBe('transient config');
    });

    it('a missing root is created by a put, and a head on a missing root is a config error, not null', async () => {
        const fresh = path.join(dir, 'fresh', 'xml');
        const onFresh = new LocalXmlStorageService(fresh);
        expect(await category(onFresh.head(KEY))).toBe('transient config');
        await onFresh.putIfAbsent(KEY, BODY, metadata());
        expect((await stat(path.join(fresh, KEY))).isFile()).toBe(true);
        expect(await onFresh.head(`issuance-status-changes/2026/10/14/issuance_13_${OTHER}.xml`)).toBeNull();
    });

    it('without a fixed directory the env decides: the s3 backend leaves the local storage with no directory', async () => {
        const previous = { storage: process.env.XML_EXPORT_STORAGE, dir: process.env.XML_EXPORT_LOCAL_DIR };
        try {
            delete process.env.XML_EXPORT_STORAGE;
            expect(await category(new LocalXmlStorageService().putIfAbsent(KEY, BODY, metadata()))).toBe('transient config');
            process.env.XML_EXPORT_STORAGE = 'local';
            process.env.XML_EXPORT_LOCAL_DIR = dir;
            await new LocalXmlStorageService().putIfAbsent(KEY, BODY, metadata());
            expect(await tree()).toEqual([KEY, `${KEY}.meta.json`]);
        } finally {
            for (const [k, v] of [['XML_EXPORT_STORAGE', previous.storage], ['XML_EXPORT_LOCAL_DIR', previous.dir]] as const) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('head', () => {
    it('a sidecar that is not json, or not an object of strings, is read as no metadata', async () => {
        await mkdir(path.dirname(path.join(dir, KEY)), { recursive: true });
        await writeFile(path.join(dir, KEY), BODY);
        for (const junk of ['not json', '[1]', 'null', JSON.stringify({ 'event-id': 7, sequence: '1' })]) {
            await writeFile(path.join(dir, `${KEY}.meta.json`), junk);
            const head = await svc.head(KEY);
            expect(head?.metadata['event-id']).toBeUndefined();
            expect(head?.metadata['content-sha256']).toBe(sha(BODY));
        }
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('resolveKey', () => {
    it('keeps a plain key under the directory and refuses the rest', () => {
        expect(resolveKey(dir, KEY)).toBe(path.join(dir, ...KEY.split('/')));
        expect(resolveKey(dir, 'x.xml')).toBe(path.join(dir, 'x.xml'));
        for (const bad of ['', '..', '../x.xml', 'a/../../x.xml', '/x.xml', 'x\0.xml', path.join(dir, '..', 'x.xml')]) {
            expect(() => resolveKey(dir, bad)).toThrow(StorageError);
            try {
                resolveKey(dir, bad);
            } catch (e) {
                expect((e as StorageError).category).toBe('permanent');
            }
        }
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('categorizeFs', () => {
    const osError = (code: string) => Object.assign(new Error(`${code}: something, open 'x'`), { code });

    it('EEXIST is the precondition, the directory family is transient with the config flag, the rest transient without', () => {
        expect(categorizeFs(osError('EEXIST'))).toMatchObject({ category: 'precondition', config: false });
        for (const code of ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']) expect(categorizeFs(osError(code))).toMatchObject({ category: 'transient', config: true, message: expect.stringContaining(code) });
        for (const code of ['EISDIR', 'EMFILE', 'ENOSPC', 'EIO']) expect(categorizeFs(osError(code))).toMatchObject({ category: 'transient', config: false });
        expect(categorizeFs(new Error('plain'))).toMatchObject({ category: 'transient', config: false, message: 'plain' });
        const own = new StorageError('permanent', 'mine');
        expect(categorizeFs(own)).toBe(own);
    });
});
