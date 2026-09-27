import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { Priority, UserRole } from '../../../shared/@core';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { IssuancesService } from './issuances.service';

//manager side. the courier reads issuances only through /api/delivery
@Controller('/api/issuances')
@UseGuards(AuthGuard)
@Roles(UserRole.manager)
export class IssuancesController {
  constructor(private readonly svc: IssuancesService) {}

  @Get()
  list(@Query() q: any) {
    return this.svc.list(q);
  }

  //before :id or nest treats "summary" as an id
  @Get('summary')
  summary() {
    return this.svc.summary();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.svc.update(+id, body, user);
  }

  @Post('assign')
  assign(@Body() body: any, @CurrentUser() user: any) {
    return this.svc.assign((body?.ids || []).map(Number), +body?.courier_id, body?.scheduled_date, user);
  }

  @Post('mark-urgent')
  markUrgent(@Body() body: any) {
    return this.svc.setPriority((body?.ids || []).map(Number), Priority.urgent);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Body() body: any, @CurrentUser() user: any) {
    return this.svc.softDelete(+id, body?.reason, user);
  }
}
