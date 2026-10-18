import { ForbiddenException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { MockIdentity, UserRole } from '../../../../shared/@core';
import { MockAuthProvider } from './mock-auth.provider';

//the provider against stubs: the request time lock on the environment, the users row behind an identity, the claims
//of the token it signs and what verify makes of them. the real route is covered by e2e/auth.e2e.spec.ts

const NAMES = ['ENVIRONMENT', 'NODE_ENV', 'ALLOW_MOCK_AUTH'];
const saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));

const managerRow = { id: 1, username: 'manager', display_name: 'דנה לוי', email: 'manager@equipment.local', role: UserRole.manager };

function build(opts: { user?: any; courier?: any } = {}) {
    const users = { findOne: jest.fn(async () => opts.user ?? null) };
    const couriers = { findOne: jest.fn(async () => opts.courier ?? null) };
    const jwt = { sign: jest.fn((claims: any) => `signed:${JSON.stringify(claims)}`), verify: jest.fn() };
    const audit = { recordDetached: jest.fn(async () => undefined) };
    const provider = new MockAuthProvider(users as any, couriers as any, jwt as any, audit as any);
    return { provider, users, couriers, jwt, audit };
}

beforeEach(() => {
    for (const k of NAMES) delete process.env[k];
    process.env.ENVIRONMENT = 'LOCAL';
});

afterAll(() => {
    for (const k of NAMES) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

describe('MockAuthProvider.login', () => {
    it('outside LOCAL without ALLOW_MOCK_AUTH answers like a missing route and touches no table', async () => {
        delete process.env.ENVIRONMENT;
        const { provider, users } = build({ user: managerRow });
        await expect(provider.login(MockIdentity.manager)).rejects.toBeInstanceOf(NotFoundException);
        expect(users.findOne).not.toHaveBeenCalled();
    });

    it('resolves the identity to its users row and derives the roles there', async () => {
        const { provider, users, jwt, audit } = build({ user: managerRow, courier: { id: 6 } });
        const res = await provider.login(MockIdentity.manager);
        expect(users.findOne).toHaveBeenCalledWith({ where: { username: 'manager' } });
        expect(res.user).toEqual({ id: 1, username: 'manager', name: 'דנה לוי', email: 'manager@equipment.local', roles: [UserRole.manager, UserRole.courier], courier_id: 6 });
        expect(jwt.sign).toHaveBeenCalledWith({ sub: 1, username: 'manager', name: 'דנה לוי', email: 'manager@equipment.local', roles: [UserRole.manager, UserRole.courier], courier_id: 6 });
        expect(audit.recordDetached).toHaveBeenCalledTimes(1);
    });

    it('with ALLOW_MOCK_AUTH=true the lock opens outside LOCAL', async () => {
        delete process.env.ENVIRONMENT;
        process.env.ALLOW_MOCK_AUTH = 'true';
        const { provider } = build({ user: managerRow });
        await expect(provider.login(MockIdentity.manager)).resolves.toMatchObject({ user: { id: 1 } });
    });

    it('a users row with a role outside the enum gets no token', async () => {
        const { provider, jwt } = build({ user: { ...managerRow, role: 'admin' } });
        await expect(provider.login(MockIdentity.manager)).rejects.toBeInstanceOf(ForbiddenException);
        expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('a seeded identity without its users row is a 503, not a 401', async () => {
        const { provider } = build();
        await expect(provider.login(MockIdentity.courier)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
});

describe('MockAuthProvider.verify', () => {
    it('maps the claims back to an IAuthUser, roles only from the signed token', async () => {
        const { provider, jwt } = build();
        jwt.verify.mockReturnValue({ sub: 3, username: 'courier1', name: 'יוסי', email: null, roles: [UserRole.courier], courier_id: 1, exp: 1 });
        await expect(provider.verify('t')).resolves.toEqual({ id: 3, username: 'courier1', name: 'יוסי', email: null, roles: [UserRole.courier], courier_id: 1 });
    });

    it('a token signed before the roles existed (one role claim) is a 401 as a whole', async () => {
        const { provider, jwt } = build();
        jwt.verify.mockReturnValue({ sub: 3, username: 'courier1', display_name: 'יוסי', role: UserRole.courier, courier_id: 1, exp: 1 });
        await expect(provider.verify('t')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('a token the secret does not match is a 401', async () => {
        const { provider, jwt } = build();
        jwt.verify.mockImplementation(() => {
            throw new Error('invalid signature');
        });
        await expect(provider.verify('t')).rejects.toBeInstanceOf(UnauthorizedException);
    });
});
