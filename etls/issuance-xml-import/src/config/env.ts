import * as os from 'os';

import { resolveFromRoot } from './paths';

//the one reader of the environment, in the style of server/src/env.ts: ENVIRONMENT=LOCAL is an explicit opt in to
//the developer conveniences (no admin token), NODE_ENV=production or ENVIRONMENT=PRODUCTION is production whatever
//else the env says, every number is checked whether or not the feature is on (a typo must not quietly run a different
//setting), and every refusal names the variable. the password is held in the config object and never logged

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type Config = {
  environment: string; //what ENVIRONMENT says, "(unset)" for the log line
  local: boolean;
  production: boolean;
  port: number; //PORT, the http listener
  db: { host: string; port: number; user: string; password: string; database: string };
  dirs: { input: string; archive: string; error: string }; //absolute, resolved against the package root
  autoStart: boolean; //ETL_AUTO_START, the polling scheduler; false is manual mode (POST /run only)
  pollMs: number;
  batchSize: number;
  minFileAgeMs: number;
  maxFileBytes: number;
  leaseMs: number;
  maxAttempts: number;
  adminToken: string | null; //null only on LOCAL: /status and /run are open then
  instanceId: string;
  logLevel: LogLevel;
};

export const DEFAULT_PORT = 3101;
export const DEFAULT_DB_PORT = 5433;

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/*──────────────────────────────────────────────────────────────────────────*/

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = isProduction(env);
  const local = (env.ENVIRONMENT ?? '').trim() === 'LOCAL' && !production;

  const adminToken = (env.ETL_ADMIN_TOKEN ?? '').trim() || null;
  if (!adminToken && !local) throw new Error('ETL_ADMIN_TOKEN is required outside ENVIRONMENT=LOCAL: /status and /run must not be open on a shared box');

  const instanceId = (env.ETL_INSTANCE_ID ?? '').trim() || `${os.hostname()}-${process.pid}`;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(instanceId)) throw new Error(`ETL_INSTANCE_ID may hold up to 64 letters, digits, ".", "_" and "-", got "${env.ETL_INSTANCE_ID}"`);

  const dirs = {
    input: resolveFromRoot((env.XML_INPUT_DIR ?? '').trim() || './data/input'),
    archive: resolveFromRoot((env.XML_ARCHIVE_DIR ?? '').trim() || './data/archive'),
    error: resolveFromRoot((env.XML_ERROR_DIR ?? '').trim() || './data/error'),
  };
  //an archive inside the input directory would be found again on every tick and renamed .1, .2, ... for good
  //case blind on windows, where Data\input and data\input are one directory
  const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (new Set(Object.values(dirs).map(key)).size !== 3) throw new Error(`XML_INPUT_DIR, XML_ARCHIVE_DIR and XML_ERROR_DIR must be three different directories, got "${dirs.input}", "${dirs.archive}", "${dirs.error}"`);

  const logLevelRaw = (env.ETL_LOG_LEVEL ?? '').trim() || 'info';
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) throw new Error(`ETL_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${env.ETL_LOG_LEVEL}"`);

  return {
    environment: local ? 'LOCAL' : (env.ENVIRONMENT ?? '').trim() || '(unset)',
    local,
    production,
    port: wholeNumber(env, 'PORT', DEFAULT_PORT, 1, 65535),
    db: {
      host: (env.DB_HOST ?? '').trim() || 'localhost',
      port: wholeNumber(env, 'DB_PORT', DEFAULT_DB_PORT, 1, 65535),
      user: (env.DB_USER ?? '').trim() || 'equipment',
      password: env.DB_PASSWORD ?? 'equipment',
      database: (env.DB_NAME ?? '').trim() || 'equipment_supply',
    },
    dirs,
    autoStart: flag(env, 'ETL_AUTO_START', true),
    pollMs: wholeNumber(env, 'ETL_POLL_INTERVAL_MS', 10000, 1000),
    batchSize: wholeNumber(env, 'ETL_BATCH_SIZE', 100, 1),
    minFileAgeMs: wholeNumber(env, 'ETL_MIN_FILE_AGE_MS', 2000, 0),
    maxFileBytes: wholeNumber(env, 'ETL_MAX_FILE_BYTES', 5 * 1024 * 1024, 1),
    leaseMs: wholeNumber(env, 'ETL_LEASE_MS', 300000, 1000),
    maxAttempts: wholeNumber(env, 'ETL_MAX_ATTEMPTS', 10, 1),
    adminToken,
    instanceId,
    logLevel: logLevelRaw as LogLevel,
  };
}

/*──────────────────────────────────────────────────────────────────────────*/

//NODE_ENV=production, or ENVIRONMENT=PRODUCTION, is production whatever else the env says, read trimmed and case blind
//like the server does: a deploy that spells it differently lands on the safe side
export function isProduction(env: NodeJS.ProcessEnv = process.env) {
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  const environment = (env.ENVIRONMENT ?? '').trim().toUpperCase();
  return nodeEnv === 'production' || environment === 'PRODUCTION';
}

//unset or blank is the default, anything else must be a whole number within [min, max] and within int4: a timer past
//2^31-1 ms fires every millisecond in node, and the lease goes into the claim as an int
const INT_MAX = 2147483647;

function wholeNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = INT_MAX) {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, got "${env[name]}"`);
  if (+raw < min) throw new Error(`${name} must be at least ${min}, got ${raw}`);
  if (+raw > max) throw new Error(`${name} must be at most ${max}, got ${raw}`);
  return +raw;
}

//unset or blank is the default; only the words true and false are accepted
function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean) {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return fallback;
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be "true" or "false", got "${env[name]}"`);
  return raw === 'true';
}
