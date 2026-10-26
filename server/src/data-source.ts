import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';

import { entities } from './entities';
import { dbSsl } from './env';

//the typeorm cli reads this file (npm run migration:run / revert / show, see package.json). the app keeps its own
//connection in app.module, this one is only for migrations, so synchronize is always off here: the cli must never
//rebuild tables from the entities. same .env and the same options as main.ts
dotenv.config({ path: '.env' });

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: +(process.env.DB_PORT || 5433),
  username: process.env.DB_USER || 'equipment',
  password: process.env.DB_PASSWORD || 'equipment',
  database: process.env.DB_NAME || 'equipment_supply',
  ssl: dbSsl(), //same switch as the app's connection, the migrations of a hosted postgres need the tls too
  entities,
  //the glob covers both the ts sources (typeorm-ts-node-commonjs) and the js in dist (migration:run:prod)
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
  logging: !!process.env.DB_LOGGING,
});
