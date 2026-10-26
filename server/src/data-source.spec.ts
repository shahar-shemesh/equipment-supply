import type { DataSource } from 'typeorm';

//data-source.ts is what npm run migration:run:prod connects with, the first command of the docker image. loading it only
//builds the DataSource, nothing connects. DB_SSL is set to an explicit value each time: the module loads server/.env
//too, and dotenv never overrides a variable that is already set

function load(): DataSource {
  let ds: DataSource;
  jest.isolateModules(() => {
    ds = require('./data-source').default;
  });
  return ds;
}

describe('data-source', () => {
  const saved = process.env.DB_SSL;

  afterEach(() => {
    if (saved === undefined) delete process.env.DB_SSL;
    else process.env.DB_SSL = saved;
  });

  it('DB_SSL=true puts tls with a verified certificate on the migration connection, the same value as the app\'s', () => {
    process.env.DB_SSL = 'true';
    expect((load().options as any).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('DB_SSL=false is a plain connection, as on a laptop and in docker compose', () => {
    process.env.DB_SSL = 'false';
    expect((load().options as any).ssl).toBe(false);
  });

  it('keeps synchronize off whatever the environment says: the cli must never rebuild tables from the entities', () => {
    process.env.DB_SSL = 'false';
    expect(load().options.synchronize).toBe(false);
  });
});
