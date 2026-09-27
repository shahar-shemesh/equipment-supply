import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { UserRole } from '../../../shared/@core';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { DeliveryService } from './delivery.service';

@Controller('/api/delivery')
@UseGuards(AuthGuard)
@Roles(UserRole.courier)
export class DeliveryController {
  constructor(private readonly svc: DeliveryService) {}

  @Get('tasks')
  list(@Query('tab') tab: string, @Query('search') search: string, @CurrentUser() user: any) {
    return this.svc.myTasks(user, tab, search);
  }

  @Get('lookup')
  lookup(@Query('number') number: string, @CurrentUser() user: any) {
    return this.svc.lookup(user, number);
  }

  @Get('tasks/:id')
  one(@Param('id') id: string, @CurrentUser() user: any) {
    return this.svc.myTask(user, +id);
  }

  @Post('tasks/:id/attempts')
  report(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.svc.report(user, +id, body);
  }
}
