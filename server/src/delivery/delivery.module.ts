import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DeliveryTask, DeliveryAttempt, Issuance, DeliveryOperation, DeliveryConflict, User } from '../entities';
import { DeliveryService } from './delivery.service';
import { DeliveryController } from './delivery.controller';
import { ConflictsService } from './conflicts.service';
import { ConflictsController } from './conflicts.controller';

@Module({
  imports: [TypeOrmModule.forFeature([DeliveryTask, DeliveryAttempt, Issuance, DeliveryOperation, DeliveryConflict, User])],
  controllers: [DeliveryController, ConflictsController],
  providers: [DeliveryService, ConflictsService],
})
export class DeliveryModule {}
