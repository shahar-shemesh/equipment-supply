import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { IAuthUser, UserRole } from '../../../shared/@core';
import { CurrentUser, Roles } from '../auth/auth.guard';
import { CouriersService } from './couriers.service';

//ניהול שליחים. the excel import from the spec (2.7.2) still has no design
@Controller('/api/couriers')
@Roles(UserRole.manager)
export class CouriersController {
  constructor(private readonly svc: CouriersService) {}

  @Get()
  list() {
    return this.svc.listWithLoad();
  }

  @Post()
  create(@Body() body: any, @CurrentUser() user: IAuthUser) {
    return this.svc.create(body, user);
  }

  //the checkboxes on the management table
  @Post('remove')
  removeMany(@Body() body: any, @CurrentUser() user: IAuthUser) {
    return this.svc.remove((body?.ids || []).map(Number), user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: IAuthUser) {
    return this.svc.update(+id, body, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: IAuthUser) {
    return this.svc.remove([+id], user);
  }
}
