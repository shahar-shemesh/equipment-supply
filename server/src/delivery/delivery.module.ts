import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DeliveryTask, DeliveryAttempt, Issuance, DeliveryOperation, DeliveryConflict, User, Courier } from '../entities';
import { DeliveryService } from './delivery.service';
import { DeliveryController } from './delivery.controller';
import { ConflictsService } from './conflicts.service';
import { ConflictsController } from './conflicts.controller';
import { CourierIdentityService } from './courier-identity.service';

@Module({
  imports: [TypeOrmModule.forFeature([DeliveryTask, DeliveryAttempt, Issuance, DeliveryOperation, DeliveryConflict, User, Courier])],
  controllers: [DeliveryController, ConflictsController],
  providers: [DeliveryService, ConflictsService, CourierIdentityService],
})
export class DeliveryModule {}
