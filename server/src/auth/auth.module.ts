import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User, Courier } from '../entities';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { jwtSecret } from '../env';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Courier]),
    //registerAsync for the same reason as TypeOrmModule in app.module: process.env is filled after the imports ran.
    //jwtSecret() throws outside LOCAL when the secret is missing or still the dev default, so the app does not start
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: jwtSecret(),
        signOptions: { expiresIn: '12h' }, //a courier shift, roughly
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard, JwtModule],
})
export class AuthModule {}
