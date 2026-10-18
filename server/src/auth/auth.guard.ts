import { CanActivate, ExecutionContext, ForbiddenException, HttpException, Inject, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IAuthUser, UserRole } from '../../../shared/@core';
import { AUTH_PROVIDER, AuthProvider } from './auth.provider';

export const ROLES_KEY = 'roles';
export const PUBLIC_KEY = 'public';

//@Roles(UserRole.manager) on a controller or a handler: one of the listed roles is enough. a handler's list replaces the
//class's, so an empty list would open the route to any signed in user by accident: it is refused when the class loads
export const Roles = (...roles: UserRole[]) => {
  if (!roles.length) throw new Error('@Roles() needs at least one role; leave the decorator off for any signed in user');
  return SetMetadata(ROLES_KEY, roles);
};

//@Public() on a handler or a controller: no token needed. the only opt out of the global guard, so every unguarded
//route is spelled out where it is declared
export const Public = () => SetMetadata(PUBLIC_KEY, true);

//@CurrentUser() user - the IAuthUser the provider verified (id, username, name, email, roles, courier_id)
export const CurrentUser = createParamDecorator((data: unknown, ctx: ExecutionContext): IAuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

/*──────────────────────────────────────────────────────────────────────────*/

//registered as APP_GUARD in auth.module.ts: every route is denied by default, a route opens with @Public(). the token
//goes to the provider of the running AUTH_MODE, this guard never looks inside it; the role check reads the list the
//provider answered, so a manager (manager + courier) passes a courier route and the resource checks of the service
//take it from there (courierIdOf in delivery.service)
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTH_PROVIDER) private provider: AuthProvider, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('missing token');

    //the provider answers with its own http exception (401 with the reason); anything else it throws (a jwks fetch
    //that failed, once cognito is wired) is still "not verified", not a 500 that the client's 401 handling never sees
    try {
      req.user = await this.provider.verify(token);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      throw new UnauthorizedException('token could not be verified');
    }

    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, targets);
    if (roles?.length && !roles.some((r) => req.user.roles.includes(r))) throw new ForbiddenException('wrong role for this route');

    return true;
  }
}
