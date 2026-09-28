import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { SeedService } from './seed.service';
import { destructiveSeedAllowed } from '../env';

// npm run seed  (from server/). boots the app context without http, runs SeedService, exits.
//the seed truncates every table, so it only runs with ENVIRONMENT=LOCAL and ALLOW_DESTRUCTIVE_SEED=true in server/.env
if (!destructiveSeedAllowed()) {
  console.log('========= !!!! seed refused ========== \nit drops every table. needs ENVIRONMENT=LOCAL and ALLOW_DESTRUCTIVE_SEED=true in server/.env');
  process.exit(1);
}

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    await app.get(SeedService).run();
  } catch (e) {
    console.log('========= !!!! seed failed ========== \n', e);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

run();
