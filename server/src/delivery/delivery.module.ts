import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DeliveryTask, DeliveryAttempt, Issuance, DeliveryOperation } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { DeliveryService } from './delivery.service';
import { DeliveryController } from './delivery.controller';

@Module({
  imports: [TypeOrmModule.forFeature([DeliveryTask, DeliveryAttempt, Issuance, DeliveryOperation]), AuthModule],
  controllers: [DeliveryController],
  providers: [DeliveryService],
})
export class DeliveryModule {}
