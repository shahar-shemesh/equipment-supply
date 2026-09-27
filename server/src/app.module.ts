import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { entities } from './entities';
import { AuthModule } from './auth/auth.module';
import { IssuancesModule } from './issuances/issuances.module';
import { CouriersModule } from './couriers/couriers.module';
import { DeliveryModule } from './delivery/delivery.module';
import { SeedModule } from './seed/seed.module';

@Module({
  imports: [
    //forRootAsync so the factory runs after main.ts loaded .env (a plain forRoot object is evaluated on import, before dotenv)
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: +(process.env.DB_PORT || 5433),
        username: process.env.DB_USER || 'equipment',
        password: process.env.DB_PASSWORD || 'equipment',
        database: process.env.DB_NAME || 'equipment_supply',
        entities,
        //synchronize rebuilds the tables from the entity classes on every start. good enough for the local foundation,
        //has to become migrations before there is a shared environment with data anyone cares about
        synchronize: true,
        logging: !!process.env.DB_LOGGING,
      }),
    }),
    AuthModule,
    IssuancesModule,
    CouriersModule,
    DeliveryModule,
    SeedModule,
  ],
})
export class AppModule {}
