import { AuditAction, AuditActorType, AuditEntityType, UserRole } from '../../../shared/@core';
import { AuditLog } from '../entities';
import { AuditService, DETAIL_STRING_MAX, scrub } from './audit.service';

//the last line before a row is written: the services already send short values, this is the guard for the caller that
//forgets. no database here, record() only hands a row to the manager it was given

describe('scrub', () => {
    it('cuts a string at the cap and leaves shorter ones whole', () => {
        expect(scrub('x'.repeat(DETAIL_STRING_MAX + 100))).toHaveLength(DETAIL_STRING_MAX);
        expect(scrub({ reason: 'short' })).toEqual({ reason: 'short' });
    });

    it('drops the keys that never belong in a row, at any level', () => {
        expect(scrub({ signature_png: 'iVBOR', password: 'p', password_hash: 'h', keep: 1 })).toEqual({ keep: 1 });
        expect(scrub({ changes: { signature_png: { from: 'a', to: 'b' }, notes: { from: null, to: 'n' } } })).toEqual({ changes: { notes: { from: null, to: 'n' } } });
    });

    it('keeps the from / to arrays of a courier zones change and drops anything nested deeper', () => {
        expect(scrub({ changes: { zones: { from: ['a'], to: ['a', 'b'] } } })).toEqual({ changes: { zones: { from: ['a'], to: ['a', 'b'] } } });
        expect(scrub({ changes: { zones: { from: [{ deep: 1 }], to: { deeper: { still: 1 } } } } })).toEqual({ changes: { zones: { from: [null], to: null } } });
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('AuditService.record', () => {
    it('inserts the row on the given manager, actor copied and details scrubbed', async () => {
        const em: any = { insert: jest.fn().mockResolvedValue(undefined) };
        await new AuditService(null as any).record(em, { actor: { id: 7, username: 'm', roles: [UserRole.manager, UserRole.courier] }, action: AuditAction.issuance_delete, entity_type: AuditEntityType.issuance, entity_id: 3, issuance_id: 3, details: { reason: 'r'.repeat(300), signature_png: 'iVBOR' } });
        expect(em.insert).toHaveBeenCalledTimes(1);
        const [entity, row] = em.insert.mock.calls[0];
        expect(entity).toBe(AuditLog);
        expect(row).toMatchObject({ actor_type: AuditActorType.user, actor_user_id: 7, actor_username: 'm', actor_role: UserRole.manager, action: AuditAction.issuance_delete, entity_id: 3, issuance_id: 3, batch_id: null });
        expect(row.details).toEqual({ reason: 'r'.repeat(DETAIL_STRING_MAX) });
    });

    it('a row without an actor is the system, unless the caller names a person it could not identify', async () => {
        const em: any = { insert: jest.fn().mockResolvedValue(undefined) };
        const svc = new AuditService(null as any);
        await svc.record(em, { action: AuditAction.system_seed, entity_type: AuditEntityType.system });
        await svc.record(em, { actor_type: AuditActorType.user, action: AuditAction.auth_login_failed, entity_type: AuditEntityType.user, details: { username: 'nobody' } });
        expect(em.insert.mock.calls[0][1]).toMatchObject({ actor_type: AuditActorType.system, actor_user_id: null, actor_username: null, actor_role: null, details: null });
        expect(em.insert.mock.calls[1][1]).toMatchObject({ actor_type: AuditActorType.user, actor_user_id: null, details: { username: 'nobody' } });
    });
});
