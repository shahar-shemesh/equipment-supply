import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { UserRole } from '../../../shared/@core';

export const ROLES_KEY = 'roles';

//@Roles(UserRole.manager) on a controller or a handler. no roles = any logged in user
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

//@CurrentUser() user - the decoded jwt payload (sub, username, role, courier_id, display_name)
export const CurrentUser = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().user;
});

/*──────────────────────────────────────────────────────────────────────────*/

//bearer token check. the token is issued by auth.service.login, which today only knows the seeded dev accounts.
//when the real identity provider is chosen this guard can stay, only the token issuing side changes
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('missing token');

    try {
      req.user = this.jwt.verify(token);
    } catch (e) {
      throw new UnauthorizedException('token expired or invalid');
    }

    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && !roles.includes(req.user.role)) throw new ForbiddenException('wrong role for this route');

    return true;
  }
}
