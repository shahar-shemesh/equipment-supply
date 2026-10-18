import { AuditAction, AuditActorType, IssuanceStatus, Priority, UserRole, XmlOutboxStatus } from '../../../shared/@core';
import { XmlOutbox } from '../entities';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, XmlOutboxService, backoffMs, toPayload } from './xml-outbox.service';

//the writer without a database: the same status guard, the sequence, what the snapshot keeps and what it never keeps.
//and the backoff curve, the one piece of arithmetic in the retry path

const issuance: any = {
    id: 12,
    sap_number: '7000001',
    number_prefix: "ס'",
    status: IssuanceStatus.assigned,
    priority: Priority.urgent,
    customer_name: 'ישראל ישראלי',
    customer_id_number: '012345678',
    customer_phone: '050-1234567',
    address_street: 'הרצל 10',
    address_city: 'תל אביב',
    delivery_date: '2026-10-20',
    self_pickup: false,
    notes: 'secret note',
    revision: 3,
};

const actor = { id: 4, username: 'c', roles: [UserRole.courier] };

//the query builder of the MAX(sequence) read, answering max as pg does for an aggregate: a string
function em(max = 0) {
    const qb: any = {};
    for (const method of ['select', 'where']) qb[method] = jest.fn().mockReturnValue(qb);
    qb.getRawOne = jest.fn().mockResolvedValue({ max: String(max) });
    return { createQueryBuilder: jest.fn().mockReturnValue(qb), qb, insert: jest.fn().mockResolvedValue(undefined) } as any;
}

const svc = new XmlOutboxService(null as any, null as any);

/*──────────────────────────────────────────────────────────────────────────*/

describe('XmlOutboxService.record', () => {
    it('inserts one pending row with the sequence one above the highest of the issuance, the statuses and the trigger', async () => {
        const manager = em(2);
        await svc.record(manager, { issuance, from: IssuanceStatus.assigned, to: IssuanceStatus.delivered, actor, trigger: AuditAction.delivery_report, details: { task_id: 9, attempt_id: 3 } });
        expect(manager.createQueryBuilder).toHaveBeenCalledWith(XmlOutbox, 'x');
        expect(manager.qb.where).toHaveBeenCalledWith('x.issuance_id = :id', { id: 12 });
        expect(manager.insert).toHaveBeenCalledTimes(1);
        const [entity, row] = manager.insert.mock.calls[0];
        expect(entity).toBe(XmlOutbox);
        expect(row).toMatchObject({ issuance_id: 12, sequence: 3, previous_status: IssuanceStatus.assigned, new_status: IssuanceStatus.delivered, trigger: AuditAction.delivery_report, status: XmlOutboxStatus.pending, attempts: 0 });
        expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(row.occurred_at).toBeInstanceOf(Date);
        expect(row.next_retry_at()).toBe('now()'); //the database clock, the one the claim compares with
        expect(row.payload.details).toEqual({ task_id: 9, attempt_id: 3 });
    });

    it('writes nothing when the status did not move, the guard is here and not at the call sites', async () => {
        const manager = em(1);
        await svc.record(manager, { issuance, from: IssuanceStatus.assigned, to: IssuanceStatus.assigned, actor, trigger: AuditAction.issuance_assign, details: { courier_id: 2 } });
        expect(manager.createQueryBuilder).not.toHaveBeenCalled();
        expect(manager.insert).not.toHaveBeenCalled();
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('toPayload', () => {
    it('keeps seven fields of the issuance and the actor, never the customer, the address, the notes or a signature', () => {
        const payload = toPayload({ issuance, from: IssuanceStatus.assigned, to: IssuanceStatus.delivered, actor, trigger: AuditAction.delivery_report, details: { task_id: 9, signature_png: 'iVBOR', customer_name: 'x', recipient_phone: '1', notes: 'n', nested: { a: 1 }, when: new Date('2026-10-14T08:00:00.000Z'), long: 'x'.repeat(300), flag: true, nothing: null } });
        expect(payload.issuance).toEqual({ id: 12, sap_number: '7000001', number_prefix: "ס'", priority: Priority.urgent, delivery_date: '2026-10-20', self_pickup: false, revision: 3 });
        expect(payload.actor).toEqual({ type: AuditActorType.user, user_id: 4, username: 'c', role: UserRole.courier });
        expect(payload.details).toEqual({ task_id: 9, when: '2026-10-14T08:00:00.000Z', long: 'x'.repeat(200), flag: true, nothing: null });
        const text = JSON.stringify(payload);
        for (const leaked of ['ישראל', '012345678', '050-1234567', 'הרצל', 'תל אביב', 'secret note', 'iVBOR', 'customer', 'address', 'recipient', 'status']) expect(text).not.toContain(leaked);
    });

    it('without an actor the row is the system\'s, and the nullable fields read as null', () => {
        const payload = toPayload({ issuance: { ...issuance, number_prefix: undefined, delivery_date: undefined }, from: IssuanceStatus.unassigned, to: IssuanceStatus.assigned, trigger: AuditAction.issuance_assign });
        expect(payload.actor).toEqual({ type: AuditActorType.system, user_id: null, username: null, role: null });
        expect(payload.issuance.number_prefix).toBeNull();
        expect(payload.issuance.delivery_date).toBeNull();
        expect(payload.details).toEqual({});
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('backoffMs', () => {
    it('doubles from 5s, caps at 15 minutes, and the jitter stays within half the value either way', () => {
        const low = () => 0;
        const high = () => 0.999999;
        expect(backoffMs(1, low)).toBe(BACKOFF_BASE_MS / 2);
        expect(backoffMs(1, high)).toBe(Math.round(BACKOFF_BASE_MS * 1.499999));
        expect(backoffMs(2, () => 0.5)).toBe(BACKOFF_BASE_MS * 2);
        expect(backoffMs(5, () => 0.5)).toBe(BACKOFF_BASE_MS * 16);
        expect(backoffMs(20, () => 0.5)).toBe(BACKOFF_CAP_MS);
        expect(backoffMs(1000, high)).toBeLessThan(BACKOFF_CAP_MS * 1.5);
        expect(backoffMs(0, () => 0.5)).toBe(BACKOFF_BASE_MS); //a count below one is treated as the first attempt
        for (let attempt = 1; attempt <= 25; attempt++) {
            const value = backoffMs(attempt);
            const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
            expect(value).toBeGreaterThanOrEqual(base * 0.5);
            expect(value).toBeLessThanOrEqual(base * 1.5);
        }
    });
});
