//everything that decides "is this a developer's machine or a real environment" is here, so the dev-only switches
//(dev accounts, default jwt secret, destructive seed, schema sync) all read the same answer.
//ENVIRONMENT=LOCAL is an explicit opt in. a deploy that forgot its env file lands on the safe side

export const DEV_JWT_SECRET = 'dev-only-secret-change-me';

export function isLocal() {
  return process.env.ENVIRONMENT === 'LOCAL' && process.env.NODE_ENV !== 'production';
}

/*──────────────────────────────────────────────────────────────────────────*/

//ALLOW_DEV_AUTH=true is for a shared test box that has no real identity provider yet. logged loudly at startup
export function devAuthAllowed() {
  return isLocal() || process.env.ALLOW_DEV_AUTH === 'true';
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

//called once from main.ts before anything listens. throws on the combinations that must never run, warns on the ones
//that are allowed but worth noticing in the log
export function assertSafeConfig(logger: { log: (m: string) => void; warn: (m: string) => void }) {
  const strategy = process.env.AUTH_STRATEGY || 'dev-local';

  jwtSecret();

  if (strategy === 'dev-local' && !devAuthAllowed()) {
    throw new Error('AUTH_STRATEGY=dev-local outside ENVIRONMENT=LOCAL. set ALLOW_DEV_AUTH=true only for a test box with no real identity provider yet');
  }
  if (strategy === 'dev-local' && !isLocal()) {
    logger.warn('!!!! dev-local auth is enabled on a non local environment (ALLOW_DEV_AUTH=true) !!!!');
  }
  if (!isLocal() && process.env.DB_SYNCHRONIZE === 'true') {
    logger.warn('DB_SYNCHRONIZE is ignored outside LOCAL, the schema needs migrations');
  }

  logger.log(`environment: ${isLocal() ? 'LOCAL' : process.env.ENVIRONMENT || '(unset)'}, auth: ${strategy}, schema sync: ${schemaSyncAllowed()}, seed allowed: ${destructiveSeedAllowed()}`);
}
