import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';

import { AttemptOutcome, IssuanceStatus, NonDeliveryReason, RecipientType, TaskStatus } from '../../../shared/@core';
import { User, Courier, Issuance, DeliveryTask, DeliveryAttempt } from '../entities';
import { DEV_PASSWORD } from '../auth/auth.constants';
import { destructiveSeedAllowed } from '../env';
import { buildIssuances, couriers, users, SAMPLE_SIGNATURE } from './seed.data';

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private dataSource: DataSource,
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Courier) private courierRepo: Repository<Courier>,
    @InjectRepository(Issuance) private issuanceRepo: Repository<Issuance>,
    @InjectRepository(DeliveryTask) private taskRepo: Repository<DeliveryTask>,
    @InjectRepository(DeliveryAttempt) private attemptRepo: Repository<DeliveryAttempt>,
  ) {}

  //wipes everything and inserts the sample set. npm run seed.
  //seed.ts checks the same flag before booting, this one is for anyone who injects the service from somewhere else
  async run() {
    if (!destructiveSeedAllowed()) throw new Error('refusing to seed: needs ENVIRONMENT=LOCAL and ALLOW_DESTRUCTIVE_SEED=true');
    this.logger.log('===== seeding, all existing rows are dropped =====');
    await this.dataSource.query('TRUNCATE TABLE delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');

    const hash = await bcrypt.hash(DEV_PASSWORD, 8); //cheap rounds, dev accounts

    const savedCouriers: Record<string, Courier> = {};
    for (const c of couriers) {
      savedCouriers[c.name] = await this.courierRepo.save(this.courierRepo.create({ ...c, active: true }));
    }

    for (const u of users) {
      const user = await this.userRepo.save(this.userRepo.create({ username: u.username, display_name: u.display_name, role: u.role, password_hash: hash }));
      if (u.courier && savedCouriers[u.courier]) {
        savedCouriers[u.courier].user_id = user.id;
        await this.courierRepo.save(savedCouriers[u.courier]);
      }
    }

    let tasks = 0;
    let attempts = 0;
    for (const row of buildIssuances()) {
      const { courier, ...data } = row;
      //the cast keeps typeorm on the single entity overload, with a plain any it picks the array one
      const issuance = await this.issuanceRepo.save(this.issuanceRepo.create(data as Partial<Issuance>));

      if (!courier) continue;
      const done = issuance.status !== IssuanceStatus.assigned;
      const task = await this.taskRepo.save(
        this.taskRepo.create({
          issuance_id: issuance.id,
          courier_id: savedCouriers[courier].id,
          status: done ? TaskStatus.done : TaskStatus.pending,
          scheduled_date: issuance.delivery_date,
          closed_at: done ? new Date() : null,
        }),
      );
      tasks++;
      if (!done) continue;

      //a closed task gets the attempt that closed it, with answers matching the issuance status
      const outcome = issuance.status as unknown as AttemptOutcome;
      await this.attemptRepo.save(
        this.attemptRepo.create({
          task_id: task.id,
          outcome,
          recipient_type: RecipientType.customer,
          recipient_name: issuance.customer_name,
          recipient_id_number: issuance.customer_id_number,
          recipient_phone: issuance.customer_phone,
          signature_png: SAMPLE_SIGNATURE,
          items: issuance.items.map((item, idx) => {
            //partial = first line delivered, the rest not. not_delivered = nobody home for every line
            const delivered = outcome === AttemptOutcome.delivered || (outcome === AttemptOutcome.partially_delivered && idx === 0);
            return {
              item_id: item.id,
              delivered,
              reason: delivered ? null : NonDeliveryReason.nobody_home,
              reason_details: delivered ? null : 'הלקוח לא היה בבית',
            };
          }),
        }),
      );
      attempts++;
    }

    this.logger.log(`seeded ${users.length} users, ${couriers.length} couriers, 30 issuances, ${tasks} tasks, ${attempts} attempts 🍺`);
    this.logger.log(`dev accounts: ${users.map((u) => u.username).join(', ')} / password ${DEV_PASSWORD}`);
  }
}
