import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TaskStatus } from '../../../shared/@core';
import { Courier, DeliveryTask } from '../entities';
import { validateCourierPayload } from './courier.validation';

//postgres unique violation on couriers.id_number: two managers saved the same person at the same moment and the
//findOne before the save did not see the other row yet. turned into the same 409 as the normal path
function isUniqueViolation(e: any) {
  return e?.driverError?.code === '23505' || e?.code === '23505';
}

@Injectable()
export class CouriersService {
  private readonly logger = new Logger(CouriersService.name);

  constructor(
    @InjectRepository(Courier) private couriers: Repository<Courier>,
    @InjectRepository(DeliveryTask) private tasks: Repository<DeliveryTask>,
  ) {}

  // /api/couriers - every active courier with the number of open tasks (the management table, the "עומס שליחים" widget and the assign dialog)
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

  /*──────────────────────────────────────────────────────────────────────────*/

  // POST /api/couriers
  //a deleted courier (active=false) with the same תעודת זהות comes back with the new details instead of a second row:
  //the old delivery tasks point at that row, so the history of the person stays in one place
  async create(body: any, user: any) {
    const data = validateCourierPayload(body);
    const existing = await this.couriers.findOne({ where: { id_number: data.id_number } });
    if (existing?.active) throw new ConflictException(`a courier with id number ${data.id_number} already exists (${existing.name})`);

    const courier = existing ? Object.assign(existing, data, { active: true }) : this.couriers.create({ ...data, active: true });
    try {
      await this.couriers.save(courier);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(`a courier with id number ${data.id_number} already exists`);
      throw e;
    }
    this.logger.log(`courier ${courier.id} (${courier.name}) ${existing ? 'brought back' : 'created'} by user ${user?.sub}`);
    return courier;
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // PATCH /api/couriers/:id - the whole form again, not a partial patch. employee_id / zones / email are not on the screen and stay as they are
  async update(id: number, body: any, user: any) {
    const data = validateCourierPayload(body);
    const courier = await this.couriers.findOne({ where: { id, active: true } });
    if (!courier) throw new NotFoundException(`courier ${id} not found`);

    const other = await this.couriers.findOne({ where: { id_number: data.id_number } });
    if (other && other.id !== id) throw new ConflictException(`a courier with id number ${data.id_number} already exists (${other.name})`);

    Object.assign(courier, data);
    try {
      await this.couriers.save(courier);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException(`a courier with id number ${data.id_number} already exists`);
      throw e;
    }
    this.logger.log(`courier ${id} (${courier.name}) updated by user ${user?.sub}`);
    return courier;
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  // DELETE /api/couriers/:id and POST /api/couriers/remove {ids}
  //soft: active=false and the row stays, delivery_tasks point at it. a courier that still holds open deliveries is
  //refused with a 409 that names them: the manager moves those issuances to someone else first (the assign dialog),
  //nothing here guesses where they should go. several at once is all or nothing.
  //the rows are locked so an assign that races this waits (issuances.service takes the same lock on the courier)
  async remove(ids: number[], user: any) {
    if (!ids.length) throw new BadRequestException('no couriers selected');

    await this.couriers.manager.transaction(async (em) => {
      const rows = await em.getRepository(Courier).createQueryBuilder('c').setLock('pessimistic_write').where('c.id IN (:...ids) AND c.active = true', { ids }).getMany();
      if (rows.length !== ids.length) throw new NotFoundException('one of the couriers does not exist');

      const busy = await em
        .getRepository(DeliveryTask)
        .createQueryBuilder('t')
        .select('t.courier_id', 'courier_id')
        .addSelect('COUNT(*)', 'count')
        .where('t.courier_id IN (:...ids) AND t.status = :s', { ids, s: TaskStatus.pending })
        .groupBy('t.courier_id')
        .getRawMany();

      if (busy.length) {
        const list = busy.map((b) => ({ id: +b.courier_id, name: rows.find((r) => r.id === +b.courier_id)?.name, count: +b.count }));
        //an object body: message for the log / generic toast, busy for the hebrew toast on the management screen
        throw new ConflictException({
          message: `couriers with open deliveries cannot be deleted, reassign them first: ${list.map((b) => `${b.name} (${b.count})`).join(', ')}`,
          busy: list,
        });
      }

      await em.update(Courier, { id: In(ids) }, { active: false });
      this.logger.warn(`couriers ${rows.map((r) => `${r.id} ${r.name}`).join(', ')} deleted by user ${user?.sub}`);
    });

    return { deleted: ids };
  }
}
