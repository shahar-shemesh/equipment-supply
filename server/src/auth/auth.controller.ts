import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { AuthService } from './auth.service';
import { AuthGuard, CurrentUser } from './auth.guard';

@Controller('/api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: any) {
    return this.auth.login(body?.username, body?.password);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: any) {
    //same shape as login's user: id next to sub
    return { id: user.sub, ...user };
  }

  @Get('dev-accounts')
  devAccounts() {
    return this.auth.devAccounts();
  }
}
