import * as os from 'os';
import * as path from 'path';

import { AuthMode } from '../../shared/@core';
import { assertSafeConfig, authMode, cognitoConfig, mockAuthAllowed, seedBulkCount, xmlExportConfig, xmlExportTarget } from './env';

//the one env reader with input of its own: SEED_BULK goes through it so a typo refuses instead of seeding a smaller set

describe('seedBulkCount', () => {
    const previous = process.env.SEED_BULK;

    afterEach(() => {
        if (previous === undefined) delete process.env.SEED_BULK;
        else process.env.SEED_BULK = previous;
    });

    it('unset or blank is the 2000 default, a whole number is taken as is, 0 included', () => {
        delete process.env.SEED_BULK;
        expect(seedBulkCount()).toBe(2000);
        for (const blank of ['', '  ']) {
            process.env.SEED_BULK = blank;
            expect(seedBulkCount()).toBe(2000);
        }
        process.env.SEED_BULK = '500';
        expect(seedBulkCount()).toBe(500);
        process.env.SEED_BULK = ' 0 ';
        expect(seedBulkCount()).toBe(0);
    });

    it('refuses anything that is not a whole number', () => {
        for (const bad of ['-5', '2.5', '1e3', 'abc', '2,000', '0x10']) {
            process.env.SEED_BULK = bad;
            expect(() => seedBulkCount()).toThrow('SEED_BULK');
        }
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

//the xml export switches: the defaults, the two variables the worker cannot start without, the numbers and the prefix
describe('xmlExportConfig', () => {
    const NAMES = ['XML_EXPORT_ENABLED', 'XML_EXPORT_STORAGE', 'XML_EXPORT_LOCAL_DIR', 'XML_EXPORT_BUCKET', 'AWS_REGION', 'XML_EXPORT_PREFIX', 'XML_EXPORT_POLL_MS', 'XML_EXPORT_BATCH', 'XML_EXPORT_LEASE_MS', 'XML_EXPORT_MAX_ATTEMPTS', 'XML_EXPORT_S3_ENDPOINT', 'XML_EXPORT_KMS_KEY_ID'];
    const saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));

    beforeEach(() => {
        for (const k of NAMES) delete process.env[k];
    });

    afterAll(() => {
        for (const k of NAMES) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('unset is off with the documented defaults, and off needs no bucket or region', () => {
        expect(xmlExportConfig()).toEqual({ enabled: false, storage: 's3', localDir: null, region: null, bucket: null, prefix: 'issuance-status-changes/', pollMs: 5000, batch: 20, leaseMs: 60000, maxAttempts: 20, endpoint: null, kmsKeyId: null });
        process.env.XML_EXPORT_ENABLED = 'yes'; //only the exact "true" turns it on
        expect(xmlExportConfig().enabled).toBe(false);
    });

    it('on without a bucket or a region refuses and names the variable; on with both reads everything', () => {
        process.env.XML_EXPORT_ENABLED = 'true';
        expect(() => xmlExportConfig()).toThrow('XML_EXPORT_BUCKET');
        process.env.XML_EXPORT_BUCKET = ' issuance-exports ';
        expect(() => xmlExportConfig()).toThrow('AWS_REGION');
        process.env.AWS_REGION = 'il-central-1';
        process.env.XML_EXPORT_PREFIX = 'sap/status/';
        process.env.XML_EXPORT_POLL_MS = '1000';
        process.env.XML_EXPORT_BATCH = '5';
        process.env.XML_EXPORT_LEASE_MS = '120000';
        process.env.XML_EXPORT_MAX_ATTEMPTS = '3';
        process.env.XML_EXPORT_S3_ENDPOINT = 'http://localhost:9000';
        process.env.XML_EXPORT_KMS_KEY_ID = 'alias/exports';
        expect(xmlExportConfig()).toEqual({ enabled: true, storage: 's3', localDir: null, region: 'il-central-1', bucket: 'issuance-exports', prefix: 'sap/status/', pollMs: 1000, batch: 5, leaseMs: 120000, maxAttempts: 3, endpoint: 'http://localhost:9000', kmsKeyId: 'alias/exports' });
    });

    it('the local backend needs no bucket or region, resolves its directory against the working directory, and any other backend name refuses', () => {
        process.env.XML_EXPORT_ENABLED = 'true';
        process.env.XML_EXPORT_STORAGE = 'local';
        expect(xmlExportConfig()).toMatchObject({ enabled: true, storage: 'local', localDir: path.resolve('./exports/xml'), bucket: null, region: null });
        expect(path.isAbsolute(xmlExportConfig().localDir)).toBe(true);
        process.env.XML_EXPORT_LOCAL_DIR = ' ../out/xml ';
        expect(xmlExportConfig().localDir).toBe(path.resolve('../out/xml'));
        process.env.XML_EXPORT_LOCAL_DIR = path.join(os.tmpdir(), 'xml');
        expect(xmlExportConfig().localDir).toBe(path.join(os.tmpdir(), 'xml'));
        expect(xmlExportTarget(xmlExportConfig())).toBe(`local ${path.join(os.tmpdir(), 'xml')}`);

        //s3 by name is the same as unset: the bucket is required again and the directory is not read
        process.env.XML_EXPORT_STORAGE = ' s3 ';
        expect(() => xmlExportConfig()).toThrow('XML_EXPORT_BUCKET');
        process.env.XML_EXPORT_BUCKET = 'b';
        process.env.AWS_REGION = 'r';
        expect(xmlExportConfig()).toMatchObject({ storage: 's3', localDir: null });
        expect(xmlExportTarget(xmlExportConfig())).toBe('s3 b/issuance-status-changes/');

        for (const bad of ['blob', 'LOCAL', 'S3', 'file']) {
            process.env.XML_EXPORT_STORAGE = bad;
            expect(() => xmlExportConfig()).toThrow('XML_EXPORT_STORAGE');
        }
        //the backend is read whether or not the worker is on, like the numbers
        delete process.env.XML_EXPORT_ENABLED;
        expect(() => xmlExportConfig()).toThrow('XML_EXPORT_STORAGE');
    });

    it('the prefix is a folder: letters, digits, dots, dashes, underscores and slashes, ending with a slash, or empty for the root', () => {
        process.env.XML_EXPORT_PREFIX = '';
        expect(xmlExportConfig().prefix).toBe('');
        process.env.XML_EXPORT_PREFIX = 'a.b-c_d/2026/';
        expect(xmlExportConfig().prefix).toBe('a.b-c_d/2026/');
        for (const bad of ['exports', 'exports/ ', 'ex ports/', 'ייצוא/', 'a?b/', '/exports/', 'a//b/', 'a/../b/', './a/', 'a/./']) {
            process.env.XML_EXPORT_PREFIX = bad;
            expect(() => xmlExportConfig()).toThrow('XML_EXPORT_PREFIX');
        }
    });

    it('the numbers must be whole and at or above their floor, whether or not the worker is on', () => {
        for (const [name, min] of [['XML_EXPORT_POLL_MS', 1000], ['XML_EXPORT_BATCH', 1], ['XML_EXPORT_LEASE_MS', 1000], ['XML_EXPORT_MAX_ATTEMPTS', 1]] as [string, number][]) {
            for (const bad of ['abc', '-1', '1.5', String(min - 1)]) {
                process.env[name] = bad;
                expect(() => xmlExportConfig()).toThrow(name);
            }
            process.env[name] = ` ${min} `;
            expect(() => xmlExportConfig()).not.toThrow();
            //int4 and the javascript timer limit: one past it is refused, the limit itself is taken
            process.env[name] = '2147483648';
            expect(() => xmlExportConfig()).toThrow(name);
            process.env[name] = '2147483647';
            expect(() => xmlExportConfig()).not.toThrow();
            delete process.env[name];
        }
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

//the auth switches: the mode, the mock lock outside LOCAL, the three cognito variables, and assertSafeConfig as the
//first lock at startup (main.ts calls it before anything listens)
describe('authMode, mockAuthAllowed, cognitoConfig and assertSafeConfig', () => {
    const NAMES = ['ENVIRONMENT', 'NODE_ENV', 'AUTH_MODE', 'ALLOW_MOCK_AUTH', 'COGNITO_REGION', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'JWT_SECRET', 'DB_SYNCHRONIZE', 'XML_EXPORT_ENABLED', 'XML_EXPORT_STORAGE'];
    const saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));
    const logger = { log: jest.fn(), warn: jest.fn() };

    beforeEach(() => {
        for (const k of NAMES) delete process.env[k];
        logger.log.mockClear();
        logger.warn.mockClear();
    });

    afterAll(() => {
        for (const k of NAMES) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    it('unset or blank is mock, the two names are taken as is, anything else refuses', () => {
        expect(authMode()).toBe(AuthMode.mock);
        process.env.AUTH_MODE = '  ';
        expect(authMode()).toBe(AuthMode.mock);
        process.env.AUTH_MODE = 'mock';
        expect(authMode()).toBe(AuthMode.mock);
        process.env.AUTH_MODE = ' cognito ';
        expect(authMode()).toBe(AuthMode.cognito);
        for (const bad of ['dev-local', 'Mock', 'COGNITO', 'entra', 'none']) {
            process.env.AUTH_MODE = bad;
            expect(() => authMode()).toThrow('AUTH_MODE');
        }
    });

    it('the mock is allowed on LOCAL, elsewhere only with the exact ALLOW_MOCK_AUTH=true', () => {
        process.env.ENVIRONMENT = 'LOCAL';
        expect(mockAuthAllowed()).toBe(true);
        process.env.ENVIRONMENT = 'prod';
        expect(mockAuthAllowed()).toBe(false);
        process.env.ALLOW_MOCK_AUTH = 'yes';
        expect(mockAuthAllowed()).toBe(false);
        process.env.ALLOW_MOCK_AUTH = 'true';
        expect(mockAuthAllowed()).toBe(true);
    });

    it('the cognito configuration names the first missing variable and trims the values', () => {
        expect(() => cognitoConfig()).toThrow('COGNITO_REGION');
        process.env.COGNITO_REGION = 'il-central-1';
        expect(() => cognitoConfig()).toThrow('COGNITO_USER_POOL_ID');
        process.env.COGNITO_USER_POOL_ID = ' il-central-1_abc ';
        expect(() => cognitoConfig()).toThrow('COGNITO_CLIENT_ID');
        process.env.COGNITO_CLIENT_ID = 'client';
        expect(cognitoConfig()).toEqual({ region: 'il-central-1', userPoolId: 'il-central-1_abc', clientId: 'client' });
        process.env.COGNITO_CLIENT_ID = '  ';
        expect(() => cognitoConfig()).toThrow('COGNITO_CLIENT_ID');
    });

    it('assertSafeConfig: mock outside LOCAL throws naming ALLOW_MOCK_AUTH, with it warns; LOCAL is quiet', () => {
        process.env.JWT_SECRET = 'a-real-secret';
        expect(() => assertSafeConfig(logger)).toThrow('ALLOW_MOCK_AUTH');
        process.env.ALLOW_MOCK_AUTH = 'true';
        expect(() => assertSafeConfig(logger)).not.toThrow();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ALLOW_MOCK_AUTH'));
        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('auth: mock'));

        logger.warn.mockClear();
        delete process.env.ALLOW_MOCK_AUTH;
        delete process.env.JWT_SECRET;
        process.env.ENVIRONMENT = 'LOCAL';
        expect(() => assertSafeConfig(logger)).not.toThrow();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('assertSafeConfig: cognito needs its three variables, the secret rule still holds, an unknown mode is refused first', () => {
        process.env.AUTH_MODE = 'cognito';
        process.env.JWT_SECRET = 'a-real-secret';
        expect(() => assertSafeConfig(logger)).toThrow('COGNITO_REGION');
        process.env.COGNITO_REGION = 'r';
        process.env.COGNITO_CLIENT_ID = 'c';
        expect(() => assertSafeConfig(logger)).toThrow('COGNITO_USER_POOL_ID');
        process.env.COGNITO_USER_POOL_ID = 'p';
        expect(() => assertSafeConfig(logger)).not.toThrow();
        expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('auth: cognito'));
        expect(logger.warn).not.toHaveBeenCalled();
        //no ALLOW_MOCK_AUTH needed in cognito mode, and the dev secret outside LOCAL is refused as before
        process.env.JWT_SECRET = 'dev-only-secret-change-me';
        expect(() => assertSafeConfig(logger)).toThrow('JWT_SECRET');
        process.env.JWT_SECRET = 'a-real-secret';
        process.env.AUTH_MODE = 'dev-local';
        expect(() => assertSafeConfig(logger)).toThrow('AUTH_MODE');
    });
});
