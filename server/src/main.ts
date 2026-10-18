import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as dotenv from 'dotenv';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { assertSafeConfig, authMode } from './env';

dotenv.config({ path: '.env' });

async function bootstrap() {
  const logger = new Logger('Main');
  assertSafeConfig(logger); //throws before anything listens when the env is unsafe (mock auth / default secret outside LOCAL)

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  //helmet's default headers (nosniff, frame-ancestors, hsts, a strict csp, no x-powered-by). the defaults need no
  //exception here: this process answers json only, no swagger and no static files. first in the chain so the cors
  //preflight and the 404s carry the headers too
  app.use(helmet());

  //the signature arrives as a png data url inside the json body, express default of 100kb is not enough.
  //2mb covers the 1mb signature limit (SIGNATURE_MAX_BYTES) after base64 and leaves room for the rest of the report
  app.useBodyParser('json', { limit: '2mb' });

  //vite proxies /api in dev, cors is for opening the courier screens from a tablet on the lan (vite --host)
  app.enableCors();

  //SIGTERM and SIGINT run onModuleDestroy, where the xml export worker stops its timer and waits for the tick in flight
  //(xml-export/xml-export.worker.ts). without this nest only does that on app.close(), which a real shutdown never calls
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`NestJS is listening on port ${port}, auth mode: ${authMode()}`);
}

bootstrap();
