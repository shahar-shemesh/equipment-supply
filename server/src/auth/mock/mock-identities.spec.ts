import { MockIdentity, UserRole } from '../../../../shared/@core';
import { couriers as seedCouriers, users as seedUsers } from '../../seed/seed.data';
import { MOCK_IDENTITIES, mockIdentity } from './mock-identities';

//the identities are only as good as the seed: a key that names a username the seed does not insert is a 503 on the
//login page

describe('mock identities', () => {
    it('one per key of MockIdentity, found by key', () => {
        expect(MOCK_IDENTITIES.map((i) => i.key).sort()).toEqual(Object.values(MockIdentity).sort());
        for (const key of Object.values(MockIdentity)) expect(mockIdentity(key)?.key).toBe(key);
        expect(mockIdentity('admin' as MockIdentity)).toBeNull();
    });

    it('every identity names a seeded user with the same name, email and role, and both have a courier row', () => {
        for (const identity of MOCK_IDENTITIES) {
            const seeded = seedUsers.find((u) => u.username === identity.username);
            expect(seeded).toBeDefined();
            expect(seeded.display_name).toBe(identity.name);
            expect(seeded.email).toBe(identity.email);
            expect(seeded.role).toBe(identity.role);
            //both identities drive: the manager opens the courier screens with tasks of their own
            expect(seeded.courier).toBeTruthy();
            expect(seedCouriers.some((c) => c.name === seeded.courier)).toBe(true);
        }
        expect(mockIdentity(MockIdentity.manager).role).toBe(UserRole.manager);
        expect(mockIdentity(MockIdentity.courier).role).toBe(UserRole.courier);
    });
});
