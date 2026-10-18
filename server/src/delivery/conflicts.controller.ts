import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { IAuthUser, UserRole } from '../../../shared/@core';
import { CurrentUser, Roles } from '../auth/auth.guard';
import { ConflictsService } from './conflicts.service';

//דוחות לבדיקה: the manager's side of the rejected reports. the courier's routes are on DeliveryController
@Controller('/api/conflicts')
@Roles(UserRole.manager)
export class ConflictsController {
  constructor(private readonly svc: ConflictsService) {}

  @Get()
  list(@Query() q: any) {
    return this.svc.list(q);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.svc.findOne(+id);
  }

  //"סימון כנבדק", never "approve": the delivery state is not touched
  @Post(':id/review')
  review(@Param('id') id: string, @Body() body: any, @CurrentUser() user: IAuthUser) {
    return this.svc.review(+id, user, body);
  }
}
