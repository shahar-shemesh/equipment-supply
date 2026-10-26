import * as dotenv from 'dotenv';
import * as http from 'http';

import { resolveFromRoot } from './config/paths';

//the .env next to package.json, whatever the working directory; quiet: dotenv's own banner would be a line that is
//not json on the log stream
dotenv.config({ path: resolveFromRoot('.env'), quiet: true });

import { buildApp } from './app';
import { loadConfig } from './config/env';
import { createPool, ping, transactionOn } from './repositories/db';
import { importFilesRepository } from './repositories/import-files.repository';
import { issuancesRepository } from './repositories/issuances.repository';
import { ensureDirs } from './services/files';
import { PipelineDeps, runOnce } from './services/pipeline';
import { countCandidates } from './services/scanner';
import { Scheduler } from './services/scheduler';
import { RunStatus } from './services/status';
import { createLogger } from './utils/logger';

//wires the pieces and listens: config, directories, pool, status, the pipeline behind the scheduler and POST /run,
//the http server, the signals. a database that is down at startup is a warning (the scheduler retries every tick
//and /health says so), a bad variable is a refusal that names it

const SHUTDOWN_TIMEOUT_MS = 30000;

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { instance_id: config.instanceId });

  await ensureDirs([config.dirs.input, config.dirs.archive, config.dirs.error]);

  const pool = createPool(config.db, (e) => logger.error('database pool error', { error: e.message }));
  const status = new RunStatus(config.instanceId, config.autoStart);
  const deps: PipelineDeps = { config, db: pool, transaction: transactionOn(pool), importFiles: importFilesRepository, issuances: issuancesRepository, logger };
  const runner = { start: (trigger: 'auto' | 'manual') => status.tryStart(trigger, (runId) => runOnce(deps, runId, trigger)) };

  const app = buildApp({ status, runner, db: { ping: () => ping(pool) }, auth: { token: config.adminToken }, awaiting: () => countCandidates(config.dirs.input), logger });
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => resolve());
  });

  if (config.adminToken === null) logger.warn('!!!! ETL_ADMIN_TOKEN is not set, /status and /run are open (ENVIRONMENT=LOCAL) !!!!');
  logger.info('issuance xml import listening', {
    port: config.port,
    environment: config.environment,
    mode: config.autoStart ? 'automatic' : 'manual',
    poll_ms: config.pollMs,
    input: config.dirs.input,
    archive: config.dirs.archive,
    error: config.dirs.error,
    db: `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`,
    db_up: await ping(pool),
  });

  const scheduler = new Scheduler({
    pollMs: config.pollMs,
    logger,
    tick: () => {
      const started = runner.start('auto');
      return started.started ? started.run : Promise.resolve(null);
    },
  });
  if (config.autoStart) scheduler.start();

  //the listener and the scheduler close first, so no run can start once the shutdown began (a POST /run in flight
  //holds its connection until its run ends, and server.close waits for it); then the last run, within a limit: a
  //run stuck on a connection that will never answer must not keep the process from exiting
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    const drained = Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), scheduler.stop()]).then(() => status.whenIdle());
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([drained.then(() => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), SHUTDOWN_TIMEOUT_MS)))]);
    clearTimeout(timer);
    if (timedOut) {
      logger.error('a run did not finish within the shutdown limit, exiting anyway; its row is reclaimed once its lease runs out', { limit_ms: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }
    await pool.end().catch(() => undefined);
    logger.info('stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  //node 20 ends the process on an unhandled rejection; here it is a log line, the scheduler chain and the server
  //stay up
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: (reason as Error)?.message ?? String(reason) });
  });
}

main().catch((e) => {
  //before the logger exists the config may have refused: plain stderr with the variable's name is what an operator reads
  process.stderr.write(`issuance xml import failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});
