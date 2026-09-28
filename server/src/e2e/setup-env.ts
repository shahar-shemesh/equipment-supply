import * as dotenv from 'dotenv';
import * as path from 'path';

//the e2e specs boot the real AppModule against a throwaway database next to the dev one, same host / user / password
//from server/.env. imported first in every e2e spec, before app.module reads process.env
dotenv.config({ path: path.join(__dirname, '../../.env') });

process.env.ENVIRONMENT = 'LOCAL';
process.env.DB_SYNCHRONIZE = 'true';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'equipment_supply_test';
process.env.AUTH_STRATEGY = 'dev-local';
process.env.DB_LOGGING = '';
