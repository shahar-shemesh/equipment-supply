import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthMode } from '../../../shared/@core';
import { User, Courier } from '../entities';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AUTH_PROVIDER } from './auth.provider';
import { MOCK_TOKEN_ISSUER, MockAuthProvider } from './mock/mock-auth.provider';
import { CognitoAuthProvider } from './cognito/cognito-auth.provider';
import { IdentityService } from './identity.service';
import { authMode, jwtSecret } from '../env';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Courier]),
    //registerAsync for the same reason as TypeOrmModule in app.module: process.env is filled after the imports ran.
    //jwtSecret() throws outside LOCAL when the secret is missing or still the dev default, so the app does not start
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: jwtSecret(),
        //a courier shift, roughly. the algorithm and the issuer are pinned on both sides: verify refuses a token with
        //another alg (none included), another iss or no iss, and an expired one, before the claims are read
        signOptions: { expiresIn: '12h', issuer: MOCK_TOKEN_ISSUER, algorithm: 'HS256' },
        verifyOptions: { issuer: MOCK_TOKEN_ISSUER, algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    IdentityService,
    MockAuthProvider,
    CognitoAuthProvider,
    //both providers exist, the mode picks which one the guard talks to. picked once at boot like the storage backend
    //of the xml export: a failing cognito never falls back to the mock
    { provide: AUTH_PROVIDER, inject: [MockAuthProvider, CognitoAuthProvider], useFactory: (mock: MockAuthProvider, cognito: CognitoAuthProvider) => (authMode() === AuthMode.cognito ? cognito : mock) },
    //global: every route of every module is guarded unless it says @Public(). the feature modules no longer carry
    //@UseGuards, a new controller is closed the moment it exists
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [MockAuthProvider, AUTH_PROVIDER, JwtModule],
})
export class AuthModule {}
