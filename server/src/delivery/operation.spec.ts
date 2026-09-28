import { BadRequestException } from '@nestjs/common';

import { NonDeliveryReason, RecipientType } from '../../../shared/@core';
import { isOperationUniqueViolation, parseClientTime, payloadHash, validateIssuanceRevision, validateOperationId } from './operation';

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

describe('validateOperationId', () => {
    it('is optional and accepts a uuid like id', () => {
        expect(validateOperationId(undefined)).toBeNull();
        expect(validateOperationId(null)).toBeNull();
        expect(validateOperationId('4d2f7c1e-8a1b-4c3d-9e0f-123456789abc')).toBe('4d2f7c1e-8a1b-4c3d-9e0f-123456789abc');
        expect(validateOperationId('op_00000001')).toBe('op_00000001');
    });

    it('refuses anything that is not a short id', () => {
        expect400(() => validateOperationId(''), 'operation_id');
        expect400(() => validateOperationId('short'), 'operation_id');
        expect400(() => validateOperationId('x'.repeat(65)), 'operation_id');
        expect400(() => validateOperationId('has spaces here'), 'operation_id');
        expect400(() => validateOperationId('כתובת בעברית'), 'operation_id');
        expect400(() => validateOperationId(12345678), 'operation_id');
    });
});

describe('validateIssuanceRevision', () => {
    it('is optional and wants a real integer', () => {
        expect(validateIssuanceRevision(undefined)).toBeNull();
        expect(validateIssuanceRevision(null)).toBeNull();
        expect(validateIssuanceRevision(3)).toBe(3);
        expect400(() => validateIssuanceRevision('3'), 'integer');
        expect400(() => validateIssuanceRevision(1.5), 'integer');
        expect400(() => validateIssuanceRevision(NaN), 'integer');
    });
});

describe('parseClientTime', () => {
    it('keeps a strict iso string and drops everything else', () => {
        expect(parseClientTime('2026-09-28T10:15:00.000Z').toISOString()).toBe('2026-09-28T10:15:00.000Z');
        expect(parseClientTime('2026-09-28T13:15:00+03:00').toISOString()).toBe('2026-09-28T10:15:00.000Z');
        expect(parseClientTime('1')).toBeNull(); //Date.parse('1') is a valid 2001 date in v8
        expect(parseClientTime('2026-09-28')).toBeNull();
        expect(parseClientTime('2026-13-45T99:99')).toBeNull();
        expect(parseClientTime(1727000000000)).toBeNull();
        expect(parseClientTime(undefined)).toBeNull();
    });
});

describe('payloadHash', () => {
    const recipient = { type: RecipientType.customer, name: 'ישראל', id_number: '012345678', phone: '050-1234567' };
    const yes = { item_id: 11, delivered: true, reason: null, reason_details: null };
    const no = { item_id: 12, delivered: false, reason: NonDeliveryReason.nobody_home, reason_details: 'x' };

    it('is a sha256 hex that ignores the answer order', () => {
        const a = payloadHash({ task_id: 1, recipient, signature_png: 'data:png', items: [yes, no] });
        const b = payloadHash({ task_id: 1, recipient, signature_png: 'data:png', items: [no, yes] });
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(a).toBe(b);
    });

    it('changes with the task, the answers, the recipient or the signature', () => {
        const base = payloadHash({ task_id: 1, recipient, signature_png: 'data:png', items: [yes, no] });
        expect(payloadHash({ task_id: 2, recipient, signature_png: 'data:png', items: [yes, no] })).not.toBe(base);
        expect(payloadHash({ task_id: 1, recipient, signature_png: 'data:png', items: [yes, { ...no, reason_details: 'y' }] })).not.toBe(base);
        expect(payloadHash({ task_id: 1, recipient: { ...recipient, phone: '050-0000000' }, signature_png: 'data:png', items: [yes, no] })).not.toBe(base);
        expect(payloadHash({ task_id: 1, recipient, signature_png: 'data:png2', items: [yes, no] })).not.toBe(base);
    });
});

describe('isOperationUniqueViolation', () => {
    it('matches only our index', () => {
        expect(isOperationUniqueViolation({ code: '23505', constraint: 'UQ_delivery_operations_user_operation' })).toBe(true);
        expect(isOperationUniqueViolation({ code: '23505', constraint: 'UQ_something_else' })).toBe(false);
        expect(isOperationUniqueViolation({ code: '40001' })).toBe(false);
        expect(isOperationUniqueViolation(new Error('x'))).toBe(false);
        expect(isOperationUniqueViolation(undefined)).toBe(false);
    });
});
