import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IAuthUser } from '../../../shared/@core';
import { Courier } from '../entities';

//the business identity behind a courier operation: the couriers row of the signed in account, read here on every call
//and never from the token. the roles say which screens and routes an account may open (a manager holds the courier
//role too), the row says which deliveries are theirs; courier_id in the token is the client's hint for its offline
//scope and nothing more. a row linked or unlinked after the login counts at once, no second sign in. an account with no
//row is refused the operation (403), not the screen. the row is not filtered by active: a deactivated courier holds no
//open tasks (couriers.service refuses the deactivation otherwise) and sees an empty board, README open decision 11
@Injectable()
export class CourierIdentityService {
  constructor(@InjectRepository(Courier) private couriers: Repository<Courier>) {}

  async resolve(user: IAuthUser): Promise<number> {
    const row = user?.id != null ? await this.couriers.findOne({ where: { user_id: user.id }, select: { id: true }, order: { active: 'DESC', id: 'DESC' } }) : null;
    if (!row) throw new ForbiddenException('this account is not linked to a courier');
    return row.id;
  }
}
