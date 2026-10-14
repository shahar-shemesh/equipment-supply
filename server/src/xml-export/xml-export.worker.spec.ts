import { XmlOutboxStatus } from '../../../shared/@core';
import { StorageError } from './s3-storage.service';
import { XmlExportWorker, objectKey } from './xml-export.worker';

//the worker against stubs: the timer with the flag on, and what the e2e spec cannot reach without a database or a
//bucket that fails on purpose. the claim and the upload paths themselves run in e2e/xml-export.e2e.spec.ts against
//the real table and an in-memory bucket

const EVENT = 'a0d17000-0000-4000-8000-000000000001';
const SHA = 'f'.repeat(64);
const ZERO = { claimed: 0, completed: 0, retried: 0, failed: 0, lost: 0 };

const ENV = ['XML_EXPORT_ENABLED', 'XML_EXPORT_BUCKET', 'AWS_REGION', 'XML_EXPORT_POLL_MS'];
const previous = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
    jest.useRealTimers();
    for (const k of ENV) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
    }
});

function row(over: Partial<any> = {}) {
    return { id: EVENT, issuance_id: 12, sequence: 1, attempts: 1, occurred_at: new Date('2026-10-14T08:00:00.000Z'), ...over } as any;
}

function worker(over: { outbox?: Partial<any>; builder?: Partial<any>; storage?: Partial<any> } = {}) {
    const outbox: any = {
        claim: jest.fn().mockResolvedValue([]),
        renew: jest.fn().mockResolvedValue(true),
        complete: jest.fn().mockResolvedValue(true),
        fail: jest.fn().mockImplementation(async (_row: any, _error: string, permanent: boolean) => (permanent ? XmlOutboxStatus.failed : XmlOutboxStatus.pending)),
        ...over.outbox,
    };
    const builder: any = { build: jest.fn().mockReturnValue({ xml: '<x/>', sha256: SHA }), ...over.builder };
    const storage: any = { putIfAbsent: jest.fn().mockResolvedValue(undefined), head: jest.fn().mockResolvedValue(null), ...over.storage };
    const w = new XmlExportWorker(outbox, builder, storage);
    const logger = (w as any).logger;
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    return { w, outbox, builder, storage, logger };
}

//one row on the first claim, nothing afterwards
function oneRow(over: Partial<any> = {}) {
    return jest.fn().mockResolvedValueOnce([row(over)]).mockResolvedValue([]);
}

const KEY = `issuance-status-changes/2026/10/14/issuance_12_${EVENT}.xml`;

/*──────────────────────────────────────────────────────────────────────────*/

describe('the timer', () => {
    it('with the flag on it ticks every XML_EXPORT_POLL_MS with the configured batch and lease, and destroy stops it after the tick in flight', async () => {
        jest.useFakeTimers();
        process.env.XML_EXPORT_ENABLED = 'true';
        process.env.XML_EXPORT_BUCKET = 'b';
        process.env.AWS_REGION = 'il-central-1';
        process.env.XML_EXPORT_POLL_MS = '2000';
        let release: (rows: any[]) => void = () => undefined;
        const gate = new Promise<any[]>((resolve) => (release = resolve));
        const { w, outbox } = worker({ outbox: { claim: jest.fn().mockResolvedValueOnce([]).mockReturnValueOnce(gate).mockResolvedValue([]) } });

        w.onApplicationBootstrap();
        expect((w as any).timer).not.toBeNull();
        expect(outbox.claim).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(2000);
        expect(outbox.claim).toHaveBeenCalledTimes(1);
        expect(outbox.claim).toHaveBeenCalledWith(20, 60000);
        await jest.advanceTimersByTimeAsync(2000);
        expect(outbox.claim).toHaveBeenCalledTimes(2); //this one is held open by the gate

        //destroy clears the timer and waits for the tick in flight
        let destroyed = false;
        const destroy = w.onModuleDestroy().then(() => (destroyed = true));
        await Promise.resolve();
        expect((w as any).timer).toBeNull();
        expect(destroyed).toBe(false);
        release([]);
        await destroy;
        expect(destroyed).toBe(true);
        await jest.advanceTimersByTimeAsync(10000);
        expect(outbox.claim).toHaveBeenCalledTimes(2);
    });

    it('with the flag off nothing ticks', async () => {
        jest.useFakeTimers();
        delete process.env.XML_EXPORT_ENABLED;
        const { w, outbox } = worker();
        w.onApplicationBootstrap();
        expect((w as any).timer).toBeNull();
        await jest.advanceTimersByTimeAsync(60000);
        expect(outbox.claim).not.toHaveBeenCalled();
        await w.onModuleDestroy();
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('a tick', () => {
    it('never rejects: a database that fails after the upload is a logged tick, and the next tick runs', async () => {
        const down = new Error('connection terminated');
        const { w, outbox, storage, logger } = worker({ outbox: { claim: oneRow(), complete: jest.fn().mockRejectedValue(down), fail: jest.fn().mockRejectedValue(down) } });
        await expect(w.tick()).resolves.toEqual(ZERO);
        expect(storage.putIfAbsent).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('tick aborted'));
        //the in flight slot is free again
        await expect(w.tick()).resolves.toEqual(ZERO);
        expect(outbox.claim).toHaveBeenCalledTimes(2);
    });

    it('in flight is handed to the next caller instead of running twice', async () => {
        let release: (rows: any[]) => void = () => undefined;
        const gate = new Promise<any[]>((resolve) => (release = resolve));
        const { w, outbox } = worker({ outbox: { claim: jest.fn().mockReturnValueOnce(gate).mockResolvedValue([]) } });
        const first = w.tick();
        const second = w.tick();
        expect(second).toBe(first);
        release([]);
        await first;
        expect(outbox.claim).toHaveBeenCalledTimes(1);
    });

    it('renews the lease, puts under the deterministic key with the metadata the head comparison reads, and completes with the fence of the claim', async () => {
        const { w, outbox, storage } = worker({ outbox: { claim: oneRow({ attempts: 3 }) } });
        await expect(w.tick()).resolves.toEqual({ ...ZERO, claimed: 1, completed: 1 });
        expect(outbox.renew).toHaveBeenCalledWith(expect.objectContaining({ id: EVENT, attempts: 3 }), 60000);
        expect(storage.putIfAbsent).toHaveBeenCalledWith(KEY, expect.any(Buffer), { 'event-id': EVENT, 'issuance-id': '12', sequence: '1', 'content-sha256': SHA });
        expect(outbox.complete).toHaveBeenCalledWith(expect.objectContaining({ id: EVENT, attempts: 3 }), KEY, SHA);
    });

    it('a row the renewal does not reach any more is lost: no upload, left to whoever holds it', async () => {
        const { w, outbox, storage } = worker({ outbox: { claim: oneRow(), renew: jest.fn().mockResolvedValue(false) } });
        await expect(w.tick()).resolves.toEqual({ ...ZERO, claimed: 1, lost: 1 });
        expect(storage.putIfAbsent).not.toHaveBeenCalled();
        expect(outbox.complete).not.toHaveBeenCalled();
        expect(outbox.fail).not.toHaveBeenCalled();
    });

    it('a completion the fence refuses is lost too, the object stays where it is', async () => {
        const { w, outbox } = worker({ outbox: { claim: oneRow(), complete: jest.fn().mockResolvedValue(false) } });
        await expect(w.tick()).resolves.toEqual({ ...ZERO, claimed: 1, lost: 1 });
        expect(outbox.fail).not.toHaveBeenCalled();
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('after a 412', () => {
    const taken = () => jest.fn().mockRejectedValue(new StorageError('precondition', 'PreconditionFailed: 412'));

    it('a head that fails sends the row back as transient, never as failed', async () => {
        const { w, outbox } = worker({ outbox: { claim: oneRow() }, storage: { putIfAbsent: taken(), head: jest.fn().mockRejectedValue(new StorageError('transient', 'SlowDown: 503')) } });
        await expect(w.tick()).resolves.toEqual({ ...ZERO, claimed: 1, retried: 1 });
        expect(outbox.fail).toHaveBeenCalledWith(expect.objectContaining({ id: EVENT }), 'transient: head after 412, SlowDown: 503', false, 20);
        expect(outbox.complete).not.toHaveBeenCalled();
    });

    it('a head that finds nothing retries the put later', async () => {
        const { w, outbox } = worker({ outbox: { claim: oneRow() }, storage: { putIfAbsent: taken(), head: jest.fn().mockResolvedValue(null) } });
        await expect(w.tick()).resolves.toEqual({ ...ZERO, claimed: 1, retried: 1 });
        expect(outbox.fail).toHaveBeenCalledWith(expect.objectContaining({ id: EVENT }), 'transient: 412 but no object under the key', false, 20);
    });

    it("the row's own object with an earlier rendering completes the row with the hash the bucket holds", async () => {
        const stored = '1'.repeat(64);
        const { w, outbox, logger } = worker({ outbox: { claim: oneRow() }, storage: { putIfAbsent: taken(), head: jest.fn().mockResolvedValue({ metadata: { 'event-id': EVENT, 'content-sha256': stored } }) } });
        await expect(w.tick()).resolves.toEqual({ ...ZERO, claimed: 1, completed: 1 });
        expect(outbox.complete).toHaveBeenCalledWith(expect.objectContaining({ id: EVENT }), KEY, stored);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('earlier rendering'));
    });

    it("another event's object under the key is a permanent key_collision", async () => {
        const { w, outbox } = worker({ outbox: { claim: oneRow() }, storage: { putIfAbsent: taken(), head: jest.fn().mockResolvedValue({ metadata: { 'event-id': 'someone-else', 'content-sha256': SHA } }) } });
        await expect(w.tick()).resolves.toEqual({ ...ZERO, claimed: 1, failed: 1 });
        expect(outbox.fail).toHaveBeenCalledWith(expect.objectContaining({ id: EVENT }), expect.stringMatching(/^key_collision: .* holds event someone-else/), true, 20);
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('objectKey', () => {
    it('is the day of occurred_at in utc, also for a row read back with the date as a string', () => {
        expect(objectKey('p/', row({ occurred_at: new Date('2026-10-14T23:30:00.000Z') }))).toBe(`p/2026/10/14/issuance_12_${EVENT}.xml`);
        expect(objectKey('', row({ occurred_at: '2026-01-02T00:00:00.000Z' }))).toBe(`2026/01/02/issuance_12_${EVENT}.xml`);
    });
});
