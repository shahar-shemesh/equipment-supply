import { BadRequestException } from '@nestjs/common';

import { normalizeIdNumber, normalizePhone, validateCourierPayload } from './courier.validation';

function expect400(fn: () => any, contains: string) {
    let err: any;
    try {
        fn();
    } catch (e) {
        err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain(contains);
}

describe('normalizeIdNumber', () => {
    it('keeps the digits and wants exactly nine of them', () => {
        expect(normalizeIdNumber('300786655')).toBe('300786655');
        expect(normalizeIdNumber(' 300-786-655 ')).toBe('300786655');
        expect(normalizeIdNumber(300786655)).toBe('300786655');
        expect400(() => normalizeIdNumber('30078665'), '9 digits');
        expect400(() => normalizeIdNumber('3007866551'), '9 digits');
        expect400(() => normalizeIdNumber(''), '9 digits');
        expect400(() => normalizeIdNumber(undefined), '9 digits');
    });
});

describe('normalizePhone', () => {
    it('prints the dash after the prefix for cellular and landline numbers', () => {
        expect(normalizePhone('0524438192')).toBe('052-4438192');
        expect(normalizePhone('052-4438192')).toBe('052-4438192');
        expect(normalizePhone('052 443 8192')).toBe('052-4438192');
        expect(normalizePhone('035555555')).toBe('03-5555555');
        expect(normalizePhone('0722334455')).toBe('072-2334455');
    });

    it('refuses anything that is not an israeli number', () => {
        expect400(() => normalizePhone('12345'), 'israeli number');
        expect400(() => normalizePhone('+972524438192'), 'israeli number');
        expect400(() => normalizePhone('0524438'), 'israeli number');
        expect400(() => normalizePhone(''), 'israeli number');
    });
});

describe('validateCourierPayload', () => {
    it('trims and squeezes the name and normalizes the rest', () => {
        expect(validateCourierPayload({ name: '  ישראל   ישראלי ', id_number: '300-786-655', phone: '0524438192' })).toEqual({
            name: 'ישראל ישראלי',
            id_number: '300786655',
            phone: '052-4438192',
        });
    });

    it('name is required and capped', () => {
        expect400(() => validateCourierPayload({ name: '   ', id_number: '300786655', phone: '0524438192' }), 'name is required');
        expect400(() => validateCourierPayload({ id_number: '300786655', phone: '0524438192' }), 'name is required');
        expect400(() => validateCourierPayload({ name: 'x'.repeat(101), id_number: '300786655', phone: '0524438192' }), 'longer than');
        expect400(() => validateCourierPayload(null), 'must be an object');
    });
});
