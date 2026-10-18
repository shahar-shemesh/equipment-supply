import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';

import { AuthMode, IAuthUser } from '../../../../shared/@core';
import { authMode, cognitoConfig, CognitoConfig } from '../../env';
import { AuthProvider } from '../auth.provider';

//AUTH_MODE=cognito: the boundary for the real identity provider (Entra ID through AWS Cognito). it holds the pool
//configuration and refuses every token, so a box configured for cognito fails closed instead of falling back to the
//mock. what to add when the pool exists (the jwks fetch, the issuer and audience checks, the claim to roles mapping)
//is in docs/auth.md; none of it is guessed here
@Injectable()
export class CognitoAuthProvider implements AuthProvider, OnModuleInit {
  readonly mode = AuthMode.cognito;
  private readonly logger = new Logger(CognitoAuthProvider.name);
  config: CognitoConfig | null = null;

  //the variables are read only when this is the active provider: in mock mode they may be absent. assertSafeConfig
  //already refused a cognito boot without them, so this is the second lock on the same door
  onModuleInit() {
    if (authMode() !== AuthMode.cognito) return;
    this.config = cognitoConfig();
    this.logger.warn(`AUTH_MODE=cognito with pool ${this.config.userPoolId} (${this.config.region}, client ${this.config.clientId}): token verification is not wired yet, every request is refused. see docs/auth.md`);
  }

  async verify(token: string): Promise<IAuthUser> {
    throw new UnauthorizedException('cognito token verification is not wired yet');
  }
}
