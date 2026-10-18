import { Body, Controller, Get, NotFoundException, Post } from '@nestjs/common';

import { AuthMode, IAuthUser } from '../../../shared/@core';
import { authMode } from '../env';
import { CurrentUser, Public } from './auth.guard';
import { validateMockLogin } from './auth.validation';
import { MockAuthProvider } from './mock/mock-auth.provider';
import { IdentityService } from './identity.service';

@Controller('/api/auth')
export class AuthController {
  constructor(private readonly mock: MockAuthProvider, private readonly identity: IdentityService) {}

  //the client asks which login the page shows instead of guessing from its own build
  @Public()
  @Get('mode')
  mode() {
    return { mode: authMode() };
  }

  //registered in every mode so the route table does not depend on env at decoration time; outside mock mode the
  //handler answers like a route that does not exist
  @Public()
  @Post('mock/login')
  mockLogin(@Body() body: any) {
    if (authMode() !== AuthMode.mock) throw new NotFoundException();
    return this.mock.login(validateMockLogin(body));
  }

  //the identity as the database holds it now, not the token's snapshot: the tablet asks here when a courier row may have
  //been linked or unlinked since the login (identity.service.ts)
  @Get('me')
  me(@CurrentUser() user: IAuthUser) {
    return this.identity.current(user);
  }
}
