import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { SeedService } from './seed.service';

// npm run seed  (from server/). boots the app context without http, runs SeedService, exits
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
