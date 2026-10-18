import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLog } from '../entities';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

//global so every service that changes state injects AuditService without listing the module: the writer is one class and
//the row rides on the caller's transaction, a module import per feature would be ceremony
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
