import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Issuance, DeliveryTask, Courier } from '../entities';
import { IssuancesService } from './issuances.service';
import { IssuancesController } from './issuances.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Issuance, DeliveryTask, Courier])],
  controllers: [IssuancesController],
  providers: [IssuancesService],
  exports: [IssuancesService],
})
export class IssuancesModule {}
