import { AuthMode, IAuthUser } from '../../../shared/@core';

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');

//the boundary between the guard and whoever issued the token. one implementation per AUTH_MODE, auth.module.ts picks
//it at boot; the guard knows only this shape. verify answers the request's user or throws an UnauthorizedException,
//it never returns a partial user
export interface AuthProvider {
  readonly mode: AuthMode;
  verify(token: string): Promise<IAuthUser>;
}
