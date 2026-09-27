import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TaskStatus } from '../../../shared/@core';
import { Courier, DeliveryTask } from '../entities';

@Injectable()
export class CouriersService {
  constructor(
    @InjectRepository(Courier) private couriers: Repository<Courier>,
    @InjectRepository(DeliveryTask) private tasks: Repository<DeliveryTask>,
  ) {}

  // /api/couriers - every active courier with the number of open tasks (the "עומס שליחים" widget and the assign dialog)
  async listWithLoad() {
    const couriers = await this.couriers.find({ where: { active: true }, order: { name: 'ASC' } });

    const pending = await this.tasks
      .createQueryBuilder('t')
      .select('t.courier_id', 'courier_id')
      .addSelect('COUNT(*)', 'count')
      .where('t.status = :s', { s: TaskStatus.pending })
      .groupBy('t.courier_id')
      .getRawMany();

    return couriers.map((c) => ({ ...c, pending: +(pending.find((p) => +p.courier_id === c.id)?.count || 0) }));
  }
}
