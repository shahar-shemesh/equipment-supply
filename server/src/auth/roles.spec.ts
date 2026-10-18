import { UserRole } from '../../../shared/@core';
import { hasRole, primaryRole, rolesOf } from '../../../shared/auth';

//the role derivation both packages read: a manager holds the courier role too, a courier only their own

describe('rolesOf', () => {
    it('a manager gets both roles, a courier one, anything else none', () => {
        expect(rolesOf(UserRole.manager)).toEqual([UserRole.manager, UserRole.courier]);
        expect(rolesOf(UserRole.courier)).toEqual([UserRole.courier]);
        expect(rolesOf(null)).toEqual([]);
        expect(rolesOf(undefined)).toEqual([]);
        expect(rolesOf('admin' as UserRole)).toEqual([]);
    });
});

describe('primaryRole', () => {
    it('the higher role wins, an empty list is null', () => {
        expect(primaryRole([UserRole.manager, UserRole.courier])).toBe(UserRole.manager);
        expect(primaryRole([UserRole.courier, UserRole.manager])).toBe(UserRole.manager);
        expect(primaryRole([UserRole.courier])).toBe(UserRole.courier);
        expect(primaryRole([])).toBeNull();
        expect(primaryRole(null)).toBeNull();
        expect(primaryRole(undefined)).toBeNull();
    });
});

describe('hasRole', () => {
    it('reads the list, nothing else', () => {
        expect(hasRole({ roles: rolesOf(UserRole.manager) }, UserRole.courier)).toBe(true);
        expect(hasRole({ roles: rolesOf(UserRole.courier) }, UserRole.manager)).toBe(false);
        expect(hasRole({ roles: [] }, UserRole.courier)).toBe(false);
        expect(hasRole({}, UserRole.courier)).toBe(false);
        expect(hasRole(null, UserRole.courier)).toBe(false);
    });
});
