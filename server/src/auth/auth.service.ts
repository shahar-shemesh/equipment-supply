import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';

import { UserRole } from '../../../shared/@core';
import { User, Courier } from '../entities';
import { DEV_PASSWORD, DEV_STRATEGY } from './auth.constants';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Courier) private couriers: Repository<Courier>,
    private jwt: JwtService,
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

    const user = await this.users.findOne({ where: { username: (username || '').trim() } });
    const ok = !!user && (await bcrypt.compare(password || '', user.password_hash));
    if (!ok) throw new UnauthorizedException('bad credentials');

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
    return { token: this.jwt.sign(payload), user: payload };
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // /api/auth/dev-accounts
  //the login page lists the seeded accounts so nobody has to remember them. empty list outside dev-local
  async devAccounts() {
    if ((process.env.AUTH_STRATEGY || DEV_STRATEGY) !== DEV_STRATEGY) return [];
    const users = await this.users.find({ order: { id: 'ASC' } });
    return users.map((u) => ({ username: u.username, display_name: u.display_name, role: u.role, password: DEV_PASSWORD }));
  }
}
