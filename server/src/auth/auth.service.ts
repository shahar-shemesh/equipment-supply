import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';

import { AuditAction, AuditActorType, AuditEntityType, UserRole } from '../../../shared/@core';
import { User, Courier } from '../entities';
import { AuditService } from '../audit/audit.service';
import { DEV_PASSWORD, DEV_STRATEGY } from './auth.constants';
import { devAuthAllowed, isLocal } from '../env';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Courier) private couriers: Repository<Courier>,
    private jwt: JwtService,
    private audit: AuditService,
  ) {}

  // /api/auth/login
  //dev-local: username + password against the seeded users table. this is the only strategy that exists.
  //production auth (2fa? national id? sso?) is not decided, do not build it here by guessing
  async login(username: string, password: string) {
    const strategy = process.env.AUTH_STRATEGY || DEV_STRATEGY;
    if (strategy !== DEV_STRATEGY) {
      this.logger.error(`AUTH_STRATEGY=${strategy} is not implemented, only ${DEV_STRATEGY} exists`);
      throw new UnauthorizedException(`auth strategy ${strategy} is not implemented`);
    }
    //main.ts already refuses to start in this state, this is the second lock on the same door
    if (!devAuthAllowed()) {
      this.logger.error('dev-local login refused: not ENVIRONMENT=LOCAL and ALLOW_DEV_AUTH is not set');
      throw new UnauthorizedException('dev login is disabled in this environment');
    }

    const user = await this.users.findOne({ where: { username: (username || '').trim() } });
    const ok = !!user && (await bcrypt.compare(password || '', user.password_hash));
    if (!ok) {
      //the one rejected request the audit log keeps: a failed login is the event itself. the name is kept only when it
      //is a real account (a wrong password on a known user is what an attack on that user looks like); a string that
      //matches no account is often a password typed into the wrong field, so only the fact is kept. the password itself
      //never gets near a row. best effort on purpose: the answer is about the credentials, a storage problem is logged
      //and does not turn the 401 into a 500
      const attempted = String(username ?? '').trim().slice(0, 100);
      try {
        await this.audit.recordDetached({ actor_type: AuditActorType.user, action: AuditAction.auth_login_failed, entity_type: AuditEntityType.user, entity_id: user?.id ?? null, details: { username: user ? attempted : null, known_user: !!user } });
      } catch (e: any) {
        this.logger.error(`failed login of ${JSON.stringify(attempted)} was not recorded: ${e?.message || e}`);
      }
      throw new UnauthorizedException('bad credentials');
    }

    //courier accounts carry their courier row id so the delivery routes do not need a lookup on every call
    const courier = user.role === UserRole.courier ? await this.couriers.findOne({ where: { user_id: user.id } }) : null;

    const payload = {
      sub: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      courier_id: courier?.id ?? null,
    };
    // console.log('login payload', payload);
    //detached: a login writes nothing else, there is no transaction to ride on
    await this.audit.recordDetached({ actor: payload, action: AuditAction.auth_login, entity_type: AuditEntityType.user, entity_id: user.id });
    //the jwt calls the user id sub, IUser calls it id. both go back so the tablet never keys its local storage on undefined
    return { token: this.jwt.sign(payload), user: { id: user.id, ...payload } };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // /api/auth/dev-accounts
  //the login page lists the seeded accounts (with the password) so nobody has to remember them.
  //empty list outside LOCAL, even on a test box with ALLOW_DEV_AUTH: a password list on a login page stays a laptop thing
  async devAccounts() {
    if (!isLocal() || (process.env.AUTH_STRATEGY || DEV_STRATEGY) !== DEV_STRATEGY) return [];
    const users = await this.users.find({ order: { id: 'ASC' } });
    return users.map((u) => ({ username: u.username, display_name: u.display_name, role: u.role, password: DEV_PASSWORD }));
  }
}
