import { UnauthorizedException } from '@nestjs/common';

import { CognitoAuthProvider } from './cognito-auth.provider';

//the boundary: nothing is read in mock mode, the three variables are required in cognito mode, every token is refused

const NAMES = ['AUTH_MODE', 'COGNITO_REGION', 'COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID'];
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

describe('CognitoAuthProvider', () => {
    it('reads nothing in mock mode', () => {
        const provider = new CognitoAuthProvider();
        provider.onModuleInit();
        expect(provider.config).toBeNull();
    });

    it('in cognito mode holds the pool configuration and names a missing variable', () => {
        process.env.AUTH_MODE = 'cognito';
        process.env.COGNITO_REGION = 'il-central-1';
        process.env.COGNITO_USER_POOL_ID = 'il-central-1_abc';
        expect(() => new CognitoAuthProvider().onModuleInit()).toThrow('COGNITO_CLIENT_ID');
        process.env.COGNITO_CLIENT_ID = 'client';
        const provider = new CognitoAuthProvider();
        provider.onModuleInit();
        expect(provider.config).toEqual({ region: 'il-central-1', userPoolId: 'il-central-1_abc', clientId: 'client' });
    });

    it('refuses every token with the boundary message', async () => {
        const provider = new CognitoAuthProvider();
        await expect(provider.verify('anything')).rejects.toThrow(UnauthorizedException);
        await expect(provider.verify('anything')).rejects.toThrow('cognito token verification is not wired yet');
    });
});
