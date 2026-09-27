import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Courier, DeliveryTask } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { CouriersService } from './couriers.service';
import { CouriersController } from './couriers.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Courier, DeliveryTask]), AuthModule],
  controllers: [CouriersController],
  providers: [CouriersService],
})
export class CouriersModule {}
