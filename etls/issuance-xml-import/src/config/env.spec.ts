import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from './env';
import { PROJECT_ROOT } from './paths';

const LOCAL = { ENVIRONMENT: 'LOCAL' };

describe('loadConfig', () => {
  it('takes the defaults on LOCAL without a token and resolves the directories against the package root', () => {
    const cfg = loadConfig({ ...LOCAL });
    expect(cfg.local).toBe(true);
    expect(cfg.production).toBe(false);
    expect(cfg.adminToken).toBeNull();
    expect(cfg.port).toBe(3101);
    expect(cfg.db).toEqual({ host: 'localhost', port: 5433, user: 'equipment', password: 'equipment', database: 'equipment_supply' });
    expect(cfg.dirs).toEqual({ input: path.join(PROJECT_ROOT, 'data', 'input'), archive: path.join(PROJECT_ROOT, 'data', 'archive'), error: path.join(PROJECT_ROOT, 'data', 'error') });
    expect(cfg.autoStart).toBe(true);
    expect([cfg.pollMs, cfg.batchSize, cfg.minFileAgeMs, cfg.maxFileBytes, cfg.leaseMs, cfg.maxAttempts]).toEqual([10000, 100, 2000, 5 * 1024 * 1024, 300000, 10]);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.instanceId).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('refuses to start outside LOCAL without ETL_ADMIN_TOKEN and names the variable', () => {
    expect(() => loadConfig({ ENVIRONMENT: 'STAGING' })).toThrow('ETL_ADMIN_TOKEN is required outside ENVIRONMENT=LOCAL');
    expect(() => loadConfig({})).toThrow('ETL_ADMIN_TOKEN');
    expect(loadConfig({ ENVIRONMENT: 'STAGING', ETL_ADMIN_TOKEN: 'secret' }).adminToken).toBe('secret');
  });

  it('is production on NODE_ENV=production or ENVIRONMENT=PRODUCTION whatever LOCAL says', () => {
    expect(() => loadConfig({ ENVIRONMENT: 'LOCAL', NODE_ENV: 'production' })).toThrow('ETL_ADMIN_TOKEN');
    const cfg = loadConfig({ ENVIRONMENT: ' production ', ETL_ADMIN_TOKEN: 't' });
    expect(cfg.production).toBe(true);
    expect(cfg.local).toBe(false);
  });

  it('reads an absolute directory as it is and a relative one against the root', () => {
    const abs = path.resolve('/srv/etl/in');
    const cfg = loadConfig({ ...LOCAL, XML_INPUT_DIR: abs, XML_ARCHIVE_DIR: 'done' });
    expect(cfg.dirs.input).toBe(abs);
    expect(cfg.dirs.archive).toBe(path.join(PROJECT_ROOT, 'done'));
  });

  it('refuses two directories that resolve to the same place', () => {
    expect(() => loadConfig({ ...LOCAL, XML_INPUT_DIR: './data/in', XML_ARCHIVE_DIR: 'data/in' })).toThrow('XML_INPUT_DIR, XML_ARCHIVE_DIR and XML_ERROR_DIR must be three different directories');
  });

  it('checks every number whether or not the feature is on, with the variable in the message', () => {
    expect(() => loadConfig({ ...LOCAL, ETL_POLL_INTERVAL_MS: 'soon' })).toThrow('ETL_POLL_INTERVAL_MS must be a whole number, got "soon"');
    expect(() => loadConfig({ ...LOCAL, ETL_POLL_INTERVAL_MS: '500' })).toThrow('ETL_POLL_INTERVAL_MS must be at least 1000, got 500');
    expect(() => loadConfig({ ...LOCAL, ETL_LEASE_MS: '2147483648' })).toThrow('ETL_LEASE_MS must be at most 2147483647');
    expect(() => loadConfig({ ...LOCAL, ETL_AUTO_START: 'false', ETL_BATCH_SIZE: '0' })).toThrow('ETL_BATCH_SIZE must be at least 1');
    expect(() => loadConfig({ ...LOCAL, PORT: '70000' })).toThrow('PORT must be at most 65535');
    expect(loadConfig({ ...LOCAL, ETL_MIN_FILE_AGE_MS: '0', ETL_MAX_ATTEMPTS: ' 3 ' }).maxAttempts).toBe(3);
  });

  it('takes only true or false for ETL_AUTO_START', () => {
    expect(loadConfig({ ...LOCAL, ETL_AUTO_START: 'false' }).autoStart).toBe(false);
    expect(loadConfig({ ...LOCAL, ETL_AUTO_START: '' }).autoStart).toBe(true);
    expect(() => loadConfig({ ...LOCAL, ETL_AUTO_START: 'yes' })).toThrow('ETL_AUTO_START must be "true" or "false", got "yes"');
  });

  it('checks the instance id and the log level', () => {
    expect(loadConfig({ ...LOCAL, ETL_INSTANCE_ID: 'etl-a.1' }).instanceId).toBe('etl-a.1');
    expect(() => loadConfig({ ...LOCAL, ETL_INSTANCE_ID: 'has space' })).toThrow('ETL_INSTANCE_ID');
    expect(() => loadConfig({ ...LOCAL, ETL_INSTANCE_ID: 'x'.repeat(65) })).toThrow('ETL_INSTANCE_ID');
    expect(loadConfig({ ...LOCAL, ETL_LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(() => loadConfig({ ...LOCAL, ETL_LOG_LEVEL: 'verbose' })).toThrow('ETL_LOG_LEVEL must be one of debug, info, warn, error');
  });

  it('keeps the password as given, spaces included, and never in the environment line', () => {
    const cfg = loadConfig({ ...LOCAL, DB_PASSWORD: ' p w ' });
    expect(cfg.db.password).toBe(' p w ');
    expect(cfg.environment).toBe('LOCAL');
    expect(loadConfig({ ETL_ADMIN_TOKEN: 't' }).environment).toBe('(unset)');
  });
});
