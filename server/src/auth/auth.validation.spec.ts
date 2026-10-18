import { BadRequestException } from '@nestjs/common';

import { MockIdentity } from '../../../shared/@core';
import { validateMockLogin } from './auth.validation';

describe('validateMockLogin', () => {
    it('accepts the two identities', () => {
        expect(validateMockLogin({ identity: 'manager' })).toBe(MockIdentity.manager);
        expect(validateMockLogin({ identity: 'courier' })).toBe(MockIdentity.courier);
    });

    it('refuses anything else with the two legal values in the message', () => {
        for (const body of [undefined, null, {}, { identity: 'admin' }, { identity: 'Manager' }, { identity: ' manager' }, { identity: ['manager'] }, { identity: 1 }, 'manager']) {
            let err: any;
            try {
                validateMockLogin(body);
            } catch (e) {
                err = e;
            }
            expect(err).toBeInstanceOf(BadRequestException);
            expect(err.message).toBe('identity must be manager or courier');
        }
    });
});
