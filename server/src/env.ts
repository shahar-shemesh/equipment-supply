import * as fs from 'fs';
import * as path from 'path';

import { AuthMode } from '../../shared/@core';

//everything that decides "is this a developer's machine or a real environment" is here, so the dev-only switches
//(mock auth, default jwt secret, destructive seed, schema sync) all read the same answer.
//ENVIRONMENT=LOCAL is an explicit opt in. a deploy that forgot its env file lands on the safe side

export const DEV_JWT_SECRET = 'dev-only-secret-change-me';

export function isLocal() {
  return process.env.ENVIRONMENT === 'LOCAL' && !isProduction();
}

//NODE_ENV=production, or ENVIRONMENT=PRODUCTION, is production whatever else the env says: no developer switch opens
//there, not even the explicit ones. both values are read trimmed and case blind, a deploy that spells it differently
//lands on the safe side
export function isProduction() {
  const nodeEnv = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  const environment = (process.env.ENVIRONMENT ?? '').trim().toUpperCase();
  return nodeEnv === 'production' || environment === 'PRODUCTION';
}

/*──────────────────────────────────────────────────────────────────────────*/

//AUTH_MODE picks the auth provider (auth/auth.module.ts): mock issues a signed jwt for one of two predefined identities,
//cognito is the boundary for the real identity provider. unset is mock so a laptop needs no new variable; anything else
//throws, a typo must not quietly run the mock on a real box
export function authMode(): AuthMode {
  const raw = (process.env.AUTH_MODE ?? '').trim();
  if (raw === '') return AuthMode.mock;
  if (raw === AuthMode.mock || raw === AuthMode.cognito) return raw;
  throw new Error(`AUTH_MODE must be "mock" or "cognito" (unset means mock), got "${process.env.AUTH_MODE}"`);
}

/*──────────────────────────────────────────────────────────────────────────*/

//ALLOW_MOCK_AUTH=true is for a shared test box that has no real identity provider yet. logged loudly at startup, and
//ignored on production: a copied env file must not turn the two button login on there
export function mockAuthAllowed() {
  return isLocal() || (process.env.ALLOW_MOCK_AUTH === 'true' && !isProduction());
}

/*──────────────────────────────────────────────────────────────────────────*/

export type CognitoConfig = { region: string; userPoolId: string; clientId: string };

//the three values the cognito provider verifies tokens against, once it does (auth/cognito/). read here only, and only
//in cognito mode: a missing one is a startup error that names it, never a provider that silently trusts nothing
export function cognitoConfig(): CognitoConfig {
  const read = (name: string) => {
    const value = (process.env[name] ?? '').trim();
    if (!value) throw new Error(`${name} is required when AUTH_MODE=cognito`);
    return value;
  };
  return { region: read('COGNITO_REGION'), userPoolId: read('COGNITO_USER_POOL_ID'), clientId: read('COGNITO_CLIENT_ID') };
}

/*──────────────────────────────────────────────────────────────────────────*/

export function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!isLocal() && (!secret || secret === DEV_JWT_SECRET)) {
    throw new Error('JWT_SECRET is missing or still the dev default. outside ENVIRONMENT=LOCAL a real secret is required');
  }
  return secret || DEV_JWT_SECRET;
}

/*──────────────────────────────────────────────────────────────────────────*/

//synchronize rebuilds tables from the entity classes. fine on a laptop, never on data anyone shares. migrations are the next step
export function schemaSyncAllowed() {
  return isLocal() && process.env.DB_SYNCHRONIZE === 'true';
}

/*──────────────────────────────────────────────────────────────────────────*/

//npm run seed truncates every table
export function destructiveSeedAllowed() {
  return isLocal() && process.env.ALLOW_DESTRUCTIVE_SEED === 'true';
}

/*──────────────────────────────────────────────────────────────────────────*/

//SEED_BULK = generated issuances the seed adds on top of the 30 handcrafted ones. unset or blank is 2000, so a plain
//npm run seed gives the board enough pages to page through; 0 keeps the handcrafted set only. anything else throws:
//a typo must not quietly seed a different set than the one asked for (+'-5' and +' ' both pass as numbers)
export function seedBulkCount() {
  const raw = (process.env.SEED_BULK ?? '').trim();
  if (raw === '') return 2000;
  if (!/^\d+$/.test(raw)) throw new Error(`SEED_BULK must be a whole number of generated issuances, got "${process.env.SEED_BULK}"`);
  return +raw;
}

/*──────────────────────────────────────────────────────────────────────────*/

export type XmlExportConfig = {
  enabled: boolean; //XML_EXPORT_ENABLED=true starts the worker. the outbox rows are written either way
  storage: 'local' | 's3'; //XML_EXPORT_STORAGE, where the documents land. unset is s3 so every existing .env keeps working
  localDir: string | null; //XML_EXPORT_LOCAL_DIR resolved to an absolute path, only with storage local
  region: string | null; //AWS_REGION, the sdk reads the same variable
  bucket: string | null; //XML_EXPORT_BUCKET
  prefix: string; //XML_EXPORT_PREFIX, the folder inside the bucket, with its trailing slash, or empty for the root
  pollMs: number; //XML_EXPORT_POLL_MS, the worker's tick
  batch: number; //XML_EXPORT_BATCH, rows per tick
  leaseMs: number; //XML_EXPORT_LEASE_MS, how long a claim belongs to its worker
  maxAttempts: number; //XML_EXPORT_MAX_ATTEMPTS, failed after that many claims
  endpoint: string | null; //XML_EXPORT_S3_ENDPOINT, path style, for MinIO or LocalStack on a laptop
  kmsKeyId: string | null; //XML_EXPORT_KMS_KEY_ID, aws:kms with this key; without it the bucket's own AES256
};

//the one reader of the xml export switches (xml-export/). bucket and region are only required while the worker is on
//with the s3 backend: a box that writes the outbox and exports nothing yet is a valid state (the backlog is exported
//once the bucket exists), and the local backend needs neither. the numbers are checked whether or not the worker is
//on, like SEED_BULK: a typo must not quietly run a different setting
export function xmlExportConfig(): XmlExportConfig {
  const enabled = process.env.XML_EXPORT_ENABLED === 'true';
  const bucket = (process.env.XML_EXPORT_BUCKET ?? '').trim() || null;
  const region = (process.env.AWS_REGION ?? '').trim() || null;

  //the backend is chosen once at startup and never falls back: a failing bucket does not turn into a directory
  const storageRaw = (process.env.XML_EXPORT_STORAGE ?? '').trim();
  if (storageRaw !== '' && storageRaw !== 'local' && storageRaw !== 's3') throw new Error(`XML_EXPORT_STORAGE must be "local" or "s3" (unset means s3), got "${process.env.XML_EXPORT_STORAGE}"`);
  const storage: 'local' | 's3' = storageRaw === 'local' ? 'local' : 's3';
  //relative to the working directory of the server process, like every other relative path node resolves
  const localDir = storage === 'local' ? path.resolve((process.env.XML_EXPORT_LOCAL_DIR ?? '').trim() || './exports/xml') : null;

  const prefix = process.env.XML_EXPORT_PREFIX ?? 'issuance-status-changes/';
  if (!/^[A-Za-z0-9._/-]*$/.test(prefix)) throw new Error(`XML_EXPORT_PREFIX may hold letters, digits, ".", "_", "-" and "/" only, got "${prefix}"`);
  if (prefix && !prefix.endsWith('/')) throw new Error(`XML_EXPORT_PREFIX must end with "/" (or be empty for the bucket root), got "${prefix}"`);
  //s3 keeps a leading slash, an empty segment or a ".." as a folder of that name: the objects would land where nobody looks
  if (prefix.startsWith('/') || prefix.includes('//') || prefix.split('/').some((seg) => seg === '.' || seg === '..')) throw new Error(`XML_EXPORT_PREFIX must be a plain folder path (no leading "/", no empty, "." or ".." segment), got "${prefix}"`);

  if (enabled && storage === 's3' && !bucket) throw new Error('XML_EXPORT_BUCKET is required when XML_EXPORT_ENABLED=true (unless XML_EXPORT_STORAGE=local)');
  if (enabled && storage === 's3' && !region) throw new Error('AWS_REGION is required when XML_EXPORT_ENABLED=true (unless XML_EXPORT_STORAGE=local)');

  return {
    enabled,
    storage,
    localDir,
    region,
    bucket,
    prefix,
    pollMs: wholeNumber('XML_EXPORT_POLL_MS', 5000, 1000),
    batch: wholeNumber('XML_EXPORT_BATCH', 20, 1),
    leaseMs: wholeNumber('XML_EXPORT_LEASE_MS', 60000, 1000),
    maxAttempts: wholeNumber('XML_EXPORT_MAX_ATTEMPTS', 20, 1),
    endpoint: (process.env.XML_EXPORT_S3_ENDPOINT ?? '').trim() || null,
    kmsKeyId: (process.env.XML_EXPORT_KMS_KEY_ID ?? '').trim() || null,
  };
}

//unset or blank is the default, anything else must be a whole number at or above the floor and within int4: a timer
//past 2^31-1 ms fires every millisecond in node, and the lease goes into the claim as an int
const INT_MAX = 2147483647;

function wholeNumber(name: string, fallback: number, min: number) {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, got "${process.env[name]}"`);
  if (+raw < min) throw new Error(`${name} must be at least ${min}, got ${raw}`);
  if (+raw > INT_MAX) throw new Error(`${name} must be at most ${INT_MAX}, got ${raw}`);
  return +raw;
}

/*──────────────────────────────────────────────────────────────────────────*/

//CLIENT_DIST = the folder of the built client (client/dist). set: the server serves the app from it as well (main.ts,
//client-static.ts), same origin, so the client's relative /api calls need no proxy. that is the one docker image. unset:
//json only, as on a laptop where vite serves the client. a folder without an index.html throws at startup naming the
//variable: a server that listens and answers 404 for the app's own page is harder to find than one that does not start.
//relative paths resolve against the working directory, like XML_EXPORT_LOCAL_DIR
export function clientDist() {
  const raw = (process.env.CLIENT_DIST ?? '').trim();
  if (raw === '') return null;
  const dir = path.resolve(raw);
  let built = false;
  try {
    built = fs.statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    //no such folder or no such file, the throw below says it
  }
  if (!built) throw new Error(`CLIENT_DIST must be the folder of the built client (client/dist), there is no index.html in "${dir}"`);
  return dir;
}

/*──────────────────────────────────────────────────────────────────────────*/

//DB_SSL=true puts tls on both connections (the app's in app.module.ts, the migration cli's in data-source.ts): a hosted
//postgres such as Neon refuses a plain one. unset, blank or false is no tls, as on a laptop and in docker compose. the
//server's certificate is always verified and there is no switch for that: a server with a private ca needs its ca, not a
//looser check. anything else throws, a typo must not quietly connect in the clear
export function dbSsl() {
  const raw = (process.env.DB_SSL ?? '').trim();
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return { rejectUnauthorized: true };
  throw new Error(`DB_SSL must be "true" or "false" (unset means false), got "${process.env.DB_SSL}"`);
}

/*──────────────────────────────────────────────────────────────────────────*/

//called once from main.ts before anything listens. throws on the combinations that must never run, warns on the ones
//that are allowed but worth noticing in the log
export function assertSafeConfig(logger: { log: (m: string) => void; warn: (m: string) => void }) {
  const mode = authMode(); //throws on an unknown mode

  //the jwt module is registered in both modes (the mock provider signs with it), so the secret rule holds in both
  jwtSecret();
  const xml = xmlExportConfig(); //throws with the variable's name when the worker is on without a bucket or a region
  const dist = clientDist(); //throws with the variable's name when the folder is not a built client
  const ssl = dbSsl(); //throws with the variable's name on anything but true or false

  if (mode === AuthMode.mock && isProduction()) {
    throw new Error('AUTH_MODE=mock on production (NODE_ENV=production or ENVIRONMENT=PRODUCTION). ALLOW_MOCK_AUTH does not open it there; set AUTH_MODE=cognito');
  }
  if (mode === AuthMode.mock && !mockAuthAllowed()) {
    throw new Error('AUTH_MODE=mock outside ENVIRONMENT=LOCAL. set ALLOW_MOCK_AUTH=true only for a test box with no real identity provider yet');
  }
  if (mode === AuthMode.mock && !isLocal()) {
    logger.warn('!!!! mock auth is enabled on a non local environment (ALLOW_MOCK_AUTH=true) !!!!');
  }
  if (mode === AuthMode.cognito) cognitoConfig(); //throws with the variable's name
  if (!isLocal() && process.env.DB_SYNCHRONIZE === 'true') {
    logger.warn('DB_SYNCHRONIZE is ignored outside LOCAL, the schema needs migrations');
  }

  logger.log(`environment: ${isLocal() ? 'LOCAL' : process.env.ENVIRONMENT || '(unset)'}, auth: ${mode}, schema sync: ${schemaSyncAllowed()}, seed allowed: ${destructiveSeedAllowed()}, xml export: ${xml.enabled ? xmlExportTarget(xml) : 'off'}, client: ${dist ?? 'off (api only)'}, db tls: ${ssl ? 'on' : 'off'}`);
}

//"local <dir>" or "s3 <bucket>/<prefix>", for the startup lines of main.ts and of the worker
export function xmlExportTarget(cfg: XmlExportConfig) {
  return cfg.storage === 'local' ? `local ${cfg.localDir}` : `s3 ${cfg.bucket}/${cfg.prefix}`;
}
