import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as dotenv from 'dotenv';

import { AppModule } from './app.module';
import { assertSafeConfig } from './env';

dotenv.config({ path: '.env' });

async function bootstrap() {
  const logger = new Logger('Main');
  assertSafeConfig(logger); //throws before anything listens when the env is unsafe (dev auth / default secret outside LOCAL)

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  //the signature arrives as a png data url inside the json body, express default of 100kb is not enough.
  //2mb covers the 1mb signature limit (SIGNATURE_MAX_BYTES) after base64 and leaves room for the rest of the report
  app.useBodyParser('json', { limit: '2mb' });

  //vite proxies /api in dev, cors is for opening the courier screens from a tablet on the lan (vite --host)
  app.enableCors();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`NestJS is listening on port ${port}, auth strategy: ${process.env.AUTH_STRATEGY || 'dev-local'}`);
}

bootstrap();
