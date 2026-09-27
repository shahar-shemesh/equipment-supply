import { Controller, Get, UseGuards } from '@nestjs/common';

import { UserRole } from '../../../shared/@core';
import { AuthGuard, Roles } from '../auth/auth.guard';
import { CouriersService } from './couriers.service';

//read only for now. create / edit / import from excel are in the spec (2.7.2) but have no design yet
@Controller('/api/couriers')
@UseGuards(AuthGuard)
@Roles(UserRole.manager)
export class CouriersController {
  constructor(private readonly svc: CouriersService) {}

  @Get()
  list() {
    return this.svc.listWithLoad();
  }
}
