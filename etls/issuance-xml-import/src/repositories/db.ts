import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import type { Config } from '../config/env';

//the pool and the two things every repository needs from it: a transaction and a liveness probe. hand written sql on
//pg, no orm at runtime (the plan's design note): the import is a handful of locked statements, and the schema stays
//typeorm's on the server side

//a pool or a client inside a transaction, whichever the caller holds
export type Queryable = {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
};

export type Transaction = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

/*──────────────────────────────────────────────────────────────────────────*/

//an idle client that errors (the server restarted under it) emits on the pool; without a listener node ends the
//process. the pool itself reconnects on the next query
export function createPool(db: Config['db'], onError: (e: Error) => void): Pool {
  const pool = new Pool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', onError);
  return pool;
}

//BEGIN, the work, COMMIT; ROLLBACK on any throw, and the client goes back to the pool either way. the rollback itself
//may fail when the connection is gone: that is logged by nobody here, the original error is what the caller needs
export function transactionOn(pool: Pool): Transaction {
  return async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  };
}

//SELECT 1 within the time budget, true or false and never a throw: /health and the startup line read it
export async function ping(pool: Pool, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([pool.query('SELECT 1').then(() => true, () => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
