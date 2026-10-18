import { ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';

import { AuditAction, AuditEntityType, AuthMode, IAuthUser, MockIdentity } from '../../../../shared/@core';
import { rolesOf } from '../../../../shared/auth';
import { User, Courier } from '../../entities';
import { AuditService } from '../../audit/audit.service';
import { AuthProvider } from '../auth.provider';
import { mockIdentity } from './mock-identities';
import { mockAuthAllowed } from '../../env';

//AUTH_MODE=mock: a signed jwt for one of the two predefined identities, no password. the identity key is the whole
//credential, so this provider only runs where mockAuthAllowed() says so (env.ts, checked at startup). the token is the
//same 12h jwt as before, signed by JwtModule with jwtSecret(); the claims are the IAuthUser with id under sub
@Injectable()
export class MockAuthProvider implements AuthProvider {
  readonly mode = AuthMode.mock;
  private readonly logger = new Logger(MockAuthProvider.name);

  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Courier) private couriers: Repository<Courier>,
    private jwt: JwtService,
    private audit: AuditService,
  ) {}

  // POST /api/auth/mock/login
  //the server maps the key to its seeded users row and derives everything else from it: roles, name, courier row.
  //a missing row is a 503 and not a 401, the fix is npm run seed, not another identity
  async login(identity: MockIdentity) {
    //main.ts already refuses to start in this state, this is the second lock on the same door: a process that got here
    //some other way (a test harness, a changed env) answers like the route does not exist
    if (!mockAuthAllowed()) {
      this.logger.error('mock login refused: not ENVIRONMENT=LOCAL and ALLOW_MOCK_AUTH is not set');
      throw new NotFoundException();
    }
    const def = mockIdentity(identity);
    const user = await this.users.findOne({ where: { username: def.username } });
    if (!user) {
      this.logger.error(`mock identity ${identity} maps to users.username ${def.username}, which does not exist. run the seed`);
      throw new ServiceUnavailableException(`mock identity ${identity} has no users row, run the seed`);
    }
    return this.issueFor(user);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //signs the token for a users row. shared with the e2e helper (e2e/auth-helper.ts), whose fixtures insert their own
  //users and have no identity key to offer. the courier row is looked up for every role: a manager's courier view
  //needs it too. the auth_login audit row is written here so a token issued either way is on record; detached, a
  //login writes nothing else
  async issueFor(user: User): Promise<{ token: string; user: IAuthUser }> {
    const courier = await this.couriers.findOne({ where: { user_id: user.id } });
    const authUser: IAuthUser = {
      id: user.id,
      username: user.username,
      name: user.display_name,
      email: user.email ?? null,
      roles: rolesOf(user.role),
      courier_id: courier?.id ?? null,
    };
    //a users.role outside the enum derives no role at all; a token with an empty list would pass only /auth/me and send
    //the client in circles between its two homes, so no token
    if (!authUser.roles.length) throw new ForbiddenException(`account ${user.username} has no role`);
    await this.audit.recordDetached({ actor: authUser, action: AuditAction.auth_login, entity_type: AuditEntityType.user, entity_id: user.id });
    const { id, ...claims } = authUser;
    return { token: this.jwt.sign({ sub: id, ...claims }), user: authUser };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  async verify(token: string): Promise<IAuthUser> {
    let claims: any;
    try {
      claims = this.jwt.verify(token);
    } catch (e) {
      throw new UnauthorizedException('token expired or invalid');
    }
    //a token signed before the roles existed (one `role` claim) is still signed with the same secret for up to 12h;
    //without the list the guard could only deny, so it is refused as a whole and the client signs in again
    if (claims?.sub == null || !Array.isArray(claims.roles)) throw new UnauthorizedException('token expired or invalid');
    return {
      id: claims.sub,
      username: claims.username,
      name: claims.name,
      email: claims.email ?? null,
      roles: claims.roles,
      courier_id: claims.courier_id ?? null,
    };
  }
}
