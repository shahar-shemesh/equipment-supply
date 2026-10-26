import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AttemptOutcome, AuditAction, AuditEntityType, IssuanceStatus, NonDeliveryReason, RecipientType, TaskStatus } from '../../../shared/@core';
import { User, Courier, Issuance, DeliveryTask, DeliveryAttempt } from '../entities';
import { AuditService } from '../audit/audit.service';
import { MOCK_IDENTITIES } from '../auth/mock/mock-identities';
import { destructiveSeedAllowed } from '../env';
import { buildBulkIssuances, buildIssuances, couriers, users, SAMPLE_SIGNATURE } from './seed.data';

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private dataSource: DataSource,
    private audit: AuditService,
  ) {}

  //wipes everything and inserts the sample set. npm run seed.
  //seed.ts checks the same flag before booting, this one is for anyone who injects the service from somewhere else.
  //bulk = generated issuances on top of the 30 handcrafted ones (seed.ts passes SEED_BULK). no options = the 30 only,
  //which is what the e2e specs that read the seed back expect
  async run(opts: { bulk?: number } = {}) {
    if (!destructiveSeedAllowed()) throw new Error('refusing to seed: needs ENVIRONMENT=LOCAL and ALLOW_DESTRUCTIVE_SEED=true');
    this.logger.log('===== seeding, all existing rows are dropped =====');
    await this.dataSource.query('TRUNCATE TABLE xml_import_files, xml_outbox, audit_log, delivery_conflicts, delivery_operations, delivery_attempt_items, delivery_attempts, delivery_tasks, issuance_items, issuances, couriers, users RESTART IDENTITY CASCADE');

    const handcrafted = buildIssuances();
    const bulk = buildBulkIssuances(opts.bulk || 0);

    let issuances = 0;
    let tasks = 0;
    let attempts = 0;
    //one transaction for the whole set. 2000 generated rows are some ten thousand inserts, autocommitted one by one that
    //is a minute of fsyncs, in one commit a few seconds. a failure half way leaves the truncated tables, not half a set
    await this.dataSource.transaction(async (em) => {
      const savedCouriers: Record<string, Courier> = {};
      for (const c of couriers) {
        savedCouriers[c.name] = await em.save(Courier, { ...c, active: true });
      }

      for (const u of users) {
        const user = await em.save(User, { username: u.username, display_name: u.display_name, email: u.email, role: u.role });
        if (u.courier) {
          //the mock identities (auth/mock/mock-identities.ts) drive through this link, a typo in seed.data must fail here
          //and not as a 403 on the tablet
          if (!savedCouriers[u.courier]) throw new Error(`seed user ${u.username} names courier "${u.courier}", which is not in the couriers list`);
          savedCouriers[u.courier].user_id = user.id;
          await em.save(Courier, savedCouriers[u.courier]);
        }
      }

      //handcrafted first so they keep the ids they always had, the generated ones after. one loop for both sets,
      //the task / attempt rules per status exist here only
      for (const row of [...handcrafted, ...bulk]) {
        const { courier, ...data } = row;
        //the cast keeps typeorm on the single entity overload, with a plain any it picks the array one
        const issuance = await em.save(Issuance, data as Partial<Issuance>);
        issuances++;

        if (!courier) continue;
        const done = issuance.status !== IssuanceStatus.assigned;
        const task = await em.save(DeliveryTask, {
          issuance_id: issuance.id,
          courier_id: savedCouriers[courier].id,
          status: done ? TaskStatus.done : TaskStatus.pending,
          scheduled_date: issuance.delivery_date,
          closed_at: done ? new Date() : null,
        });
        tasks++;
        if (!done) continue;

        //a closed task gets the attempt that closed it, with answers matching the issuance status
        const outcome = issuance.status as unknown as AttemptOutcome;
        await em.save(DeliveryAttempt, {
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
        });
        attempts++;
      }
    });

    //the first system actor: the truncate above wiped the log, this row signs the state everything after it builds on
    await this.audit.recordDetached({ action: AuditAction.system_seed, entity_type: AuditEntityType.system, details: { users: users.length, couriers: couriers.length, issuances } });

    this.logger.log(`seeded ${users.length} users, ${couriers.length} couriers, ${issuances} issuances (${handcrafted.length} handcrafted + ${bulk.length} generated), ${tasks} tasks, ${attempts} attempts 🍺`);
    this.logger.log(`mock identities: ${MOCK_IDENTITIES.map((i) => `${i.key} -> ${i.username}`).join(', ')}`);
  }
}
