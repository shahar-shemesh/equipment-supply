import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Issuance, DeliveryTask, Courier } from '../entities';
import { AuthModule } from '../auth/auth.module';
import { IssuancesService } from './issuances.service';
import { IssuancesController } from './issuances.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Issuance, DeliveryTask, Courier]), AuthModule],
  controllers: [IssuancesController],
  providers: [IssuancesService],
  exports: [IssuancesService],
})
export class IssuancesModule {}
