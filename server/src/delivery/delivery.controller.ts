import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { IAuthUser, UserRole } from '../../../shared/@core';
import { CurrentUser, Roles } from '../auth/auth.guard';
import { DeliveryService } from './delivery.service';
import { ConflictsService } from './conflicts.service';

@Controller('/api/delivery')
@Roles(UserRole.courier)
export class DeliveryController {
  constructor(private readonly svc: DeliveryService, private readonly conflicts: ConflictsService) {}

  @Get('tasks')
  list(@Query('tab') tab: string, @Query('search') search: string, @CurrentUser() user: IAuthUser) {
    return this.svc.myTasks(user, tab, search);
  }

  @Get('lookup')
  lookup(@Query('number') number: string, @CurrentUser() user: IAuthUser) {
    return this.svc.lookup(user, number);
  }

  //the review status of this courier's own rejected reports, by operation id (the tablet asks after an upload)
  @Get('conflicts')
  myConflicts(@Query('operation_ids') ids: string, @CurrentUser() user: IAuthUser) {
    return this.conflicts.mine(user, ids);
  }

  @Get('tasks/:id')
  one(@Param('id') id: string, @CurrentUser() user: IAuthUser) {
    return this.svc.myTask(user, +id);
  }

  @Post('tasks/:id/attempts')
  report(@Param('id') id: string, @Body() body: any, @CurrentUser() user: IAuthUser) {
    return this.svc.report(user, +id, body);
  }

  //a report the attempts route refused with a 409, handed over as evidence for the manager. same body as the attempt
  @Post('tasks/:id/conflicts')
  keep(@Param('id') id: string, @Body() body: any, @CurrentUser() user: IAuthUser) {
    return this.conflicts.record(user, +id, body);
  }
}
