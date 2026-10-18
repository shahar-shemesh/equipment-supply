import { Controller, Get, Param, Post } from '@nestjs/common';

import { IAuthUser, UserRole } from '../../../shared/@core';
import { CurrentUser, Roles } from '../auth/auth.guard';
import { XmlOutboxService } from './xml-outbox.service';

//the manager's window on the outbox: the counts and the failed rows, and the one action, a retry of a failed row.
//nothing here writes a document, the worker does
@Controller('/api/xml-export')
@Roles(UserRole.manager)
export class XmlExportController {
  constructor(private readonly svc: XmlOutboxService) {}

  @Get()
  overview() {
    return this.svc.overview();
  }

  @Post(':id/retry')
  retry(@Param('id') id: string, @CurrentUser() user: IAuthUser) {
    return this.svc.retry(id, user);
  }
}
