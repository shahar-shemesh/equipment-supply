import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthMode, IAuthUser, UserRole } from '../../../shared/@core';
import { rolesOf } from '../../../shared/auth';
import { AuthGuard, Public, Roles } from './auth.guard';
import { AuthProvider } from './auth.provider';

//the global guard against a fake provider: the opt out, the header, what the provider answers and the role list.
//the real providers are covered by their own specs and by auth.e2e.spec

const manager: IAuthUser = { id: 1, username: 'm', name: 'manager', email: null, roles: rolesOf(UserRole.manager), courier_id: 9 };
const courier: IAuthUser = { id: 2, username: 'c', name: 'courier', email: null, roles: rolesOf(UserRole.courier), courier_id: 3 };

//a provider that knows two tokens and refuses everything else like the mock one does
const provider: AuthProvider = {
    mode: AuthMode.mock,
    async verify(token: string) {
        if (token === 'manager-token') return manager;
        if (token === 'courier-token') return courier;
        throw new UnauthorizedException('token expired or invalid');
    },
};

//the decorators write metadata on a class and a method, the context hands both to the reflector like nest does
function contextOf(handler: Function, cls: Function, authorization?: string) {
    const req: any = { headers: authorization ? { authorization } : {} };
    const ctx = {
        getHandler: () => handler,
        getClass: () => cls,
        switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { ctx, req };
}

@Roles(UserRole.manager)
class ManagerController {
    list() {}
    @Public() mode() {}
    @Roles(UserRole.courier) handover() {}
}

@Roles(UserRole.courier)
class CourierController {
    tasks() {}
}

class OpenController {
    me() {}
}

const guard = new AuthGuard(provider, new Reflector());

describe('AuthGuard', () => {
    it('a public handler passes without a token and sets no user', async () => {
        const { ctx, req } = contextOf(ManagerController.prototype.mode, ManagerController);
        expect(await guard.canActivate(ctx)).toBe(true);
        expect(req.user).toBeUndefined();
    });

    it('no token or a header that is not a bearer is a 401 before the provider is asked', async () => {
        for (const header of [undefined, '', 'manager-token', 'Basic manager-token', 'bearer manager-token']) {
            const { ctx } = contextOf(ManagerController.prototype.list, ManagerController, header);
            await expect(guard.canActivate(ctx)).rejects.toThrow(new UnauthorizedException('missing token'));
        }
    });

    it('what the provider refuses is refused as it said', async () => {
        const { ctx } = contextOf(OpenController.prototype.me, OpenController, 'Bearer garbage');
        await expect(guard.canActivate(ctx)).rejects.toThrow(new UnauthorizedException('token expired or invalid'));
    });

    it('a verified user lands on the request, any role passes a route without @Roles', async () => {
        for (const [token, user] of [['manager-token', manager], ['courier-token', courier]] as const) {
            const { ctx, req } = contextOf(OpenController.prototype.me, OpenController, `Bearer ${token}`);
            expect(await guard.canActivate(ctx)).toBe(true);
            expect(req.user).toEqual(user);
        }
    });

    it('one of the listed roles is enough: a manager passes a courier route, a courier does not pass a manager route', async () => {
        expect(await guard.canActivate(contextOf(ManagerController.prototype.list, ManagerController, 'Bearer manager-token').ctx)).toBe(true);
        expect(await guard.canActivate(contextOf(CourierController.prototype.tasks, CourierController, 'Bearer manager-token').ctx)).toBe(true);
        expect(await guard.canActivate(contextOf(CourierController.prototype.tasks, CourierController, 'Bearer courier-token').ctx)).toBe(true);
        await expect(guard.canActivate(contextOf(ManagerController.prototype.list, ManagerController, 'Bearer courier-token').ctx)).rejects.toThrow(new ForbiddenException('wrong role for this route'));
    });

    it('a handler level @Roles overrides the class level one', async () => {
        expect(await guard.canActivate(contextOf(ManagerController.prototype.handover, ManagerController, 'Bearer courier-token').ctx)).toBe(true);
    });

    it('a provider failure that is not an http exception is a 401, not a 500', async () => {
        const failing: AuthProvider = { mode: AuthMode.cognito, verify: async () => { throw new Error('jwks fetch failed'); } };
        const guard = new AuthGuard(failing, new Reflector());
        const { ctx } = contextOf(ManagerController.prototype.list, ManagerController, 'Bearer manager-token');
        await expect(guard.canActivate(ctx)).rejects.toThrow(new UnauthorizedException('token could not be verified'));
    });

    it('@Roles() with no role is refused when the class is defined', () => {
        expect(() => Roles()).toThrow('@Roles() needs at least one role');
    });
});
