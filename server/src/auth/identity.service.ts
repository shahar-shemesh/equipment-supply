import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IAuthUser } from '../../../shared/@core';
import { rolesOf } from '../../../shared/auth';
import { User, Courier } from '../entities';

//the identity of an account as the database holds it now: the users row (name, email, the role the list derives from)
//and the courier row linked to it. the login signs it once into the token; GET /api/auth/me answers it again on request,
//so the tablet learns about a courier row linked or unlinked after the login without a new sign in. the token stays
//what it was (it authenticates), the identity is the data behind it. the guard reads the roles of the token until it
//expires: a changed users.role reaches the routes with the next login, the screens with the next /me
@Injectable()
export class IdentityService {
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Courier) private couriers: Repository<Courier>,
  ) {}

  async of(user: User): Promise<IAuthUser> {
    const courier = await this.couriers.findOne({ where: { user_id: user.id }, select: { id: true } });
    return { id: user.id, username: user.username, name: user.display_name, email: user.email ?? null, roles: rolesOf(user.role), courier_id: courier?.id ?? null };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //for a verified token: the account behind its sub. an account that is gone ends the session, the token alone is not
  //an identity
  async current(auth: IAuthUser): Promise<IAuthUser> {
    const user = await this.users.findOne({ where: { id: auth.id } });
    if (!user) throw new UnauthorizedException('account not found');
    return this.of(user);
  }
}
