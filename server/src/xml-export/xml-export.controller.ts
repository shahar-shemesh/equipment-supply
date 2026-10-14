import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { UserRole } from '../../../shared/@core';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { XmlOutboxService } from './xml-outbox.service';

//the manager's window on the outbox: the counts and the failed rows, and the one action, a retry of a failed row.
//nothing here writes a document, the worker does
@Controller('/api/xml-export')
@UseGuards(AuthGuard)
@Roles(UserRole.manager)
export class XmlExportController {
  constructor(private readonly svc: XmlOutboxService) {}

  @Get()
  overview() {
    return this.svc.overview();
  }

  @Post(':id/retry')
  retry(@Param('id') id: string, @CurrentUser() user: any) {
    return this.svc.retry(id, user);
  }
}
