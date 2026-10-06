import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { UserRole } from '../../../shared/@core';
import { AuthGuard, Roles } from '../auth/auth.guard';
import { AuditService } from './audit.service';

//read only. the rows are written by the services inside their own transactions, nothing here changes the table
@Controller('/api/audit')
@UseGuards(AuthGuard)
@Roles(UserRole.manager)
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  @Get()
  list(@Query() q: any) {
    return this.svc.list(q);
  }
}
