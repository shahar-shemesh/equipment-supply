import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { entities } from '../entities';
import { SeedService } from './seed.service';

@Module({
  imports: [TypeOrmModule.forFeature(entities)],
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
