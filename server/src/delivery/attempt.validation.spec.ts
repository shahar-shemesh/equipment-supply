import { BadRequestException } from '@nestjs/common';

import { AttemptOutcome, NonDeliveryReason, RecipientType } from '../../../shared/@core';
import { outcomeOf, validateItemAnswers, validateRecipient, validateSignature, SIGNATURE_MAX_BYTES } from './attempt.validation';

const items = [{ id: 11 }, { id: 12 }];

//1x1 transparent png, same as the seed
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

describe('validateItemAnswers', () => {
    it('accepts one boolean answer per item and normalizes delivered lines', () => {
        const out = validateItemAnswers(items, [
            { item_id: 11, delivered: true },
            { item_id: '12', delivered: false, reason: NonDeliveryReason.nobody_home, reason_details: '  no one home  ' },
        ]);
        expect(out).toEqual([
            { item_id: 11, delivered: true, reason: null, reason_details: null },
            { item_id: 12, delivered: false, reason: NonDeliveryReason.nobody_home, reason_details: 'no one home' },
        ]);
    });

    it('rejects a missing item', () => {
        expect400(() => validateItemAnswers(items, [{ item_id: 11, delivered: true }]), 'expected 2 item answers');
    });

    it('rejects an unknown item id', () => {
        expect400(() => validateItemAnswers(items, [{ item_id: 11, delivered: true }, { item_id: 99, delivered: true }]), 'unknown item 99');
    });

    it('rejects a duplicate item id even when the count matches', () => {
        expect400(() => validateItemAnswers(items, [{ item_id: 11, delivered: true }, { item_id: 11, delivered: true }]), 'duplicate answer for item 11');
    });

    it('rejects delivered that is not a real boolean', () => {
        expect400(() => validateItemAnswers(items, [{ item_id: 11, delivered: 'true' }, { item_id: 12, delivered: true }]), 'delivered must be true or false');
        expect400(() => validateItemAnswers(items, [{ item_id: 11, delivered: 1 }, { item_id: 12, delivered: true }]), 'delivered must be true or false');
        expect400(() => validateItemAnswers(items, [{ item_id: 11 }, { item_id: 12, delivered: true }]), 'delivered must be true or false');
    });

    it('rejects a not delivered line without a reason, with an unknown reason, or without details', () => {
        expect400(() => validateItemAnswers(items, [{ item_id: 11, delivered: true }, { item_id: 12, delivered: false }]), 'unknown reason');
        expect400(() => validateItemAnswers(items, [{ item_id: 11, delivered: true }, { item_id: 12, delivered: false, reason: 'dog ate it', reason_details: 'x' }]), 'unknown reason');
        expect400(() => validateItemAnswers(items, [{ item_id: 11, delivered: true }, { item_id: 12, delivered: false, reason: NonDeliveryReason.other, reason_details: '   ' }]), 'reason details are required');
    });

    it('rejects details over 100 chars', () => {
        const long = 'x'.repeat(101);
        expect400(() => validateItemAnswers(items, [{ item_id: 11, delivered: true }, { item_id: 12, delivered: false, reason: NonDeliveryReason.other, reason_details: long }]), 'longer than 100');
    });

    it('rejects a reason on a delivered line', () => {
        expect400(() => validateItemAnswers(items, [{ item_id: 11, delivered: true, reason: NonDeliveryReason.other }, { item_id: 12, delivered: true }]), 'does not belong here');
    });

    it('rejects non array and non object entries', () => {
        expect400(() => validateItemAnswers(items, { item_id: 11 }), 'must be an array');
        expect400(() => validateItemAnswers(items, ['nope', 1]), 'must be an object');
    });

    it('rejects an issuance without items', () => {
        expect400(() => validateItemAnswers([], []), 'no items');
    });
});

describe('outcomeOf', () => {
    const yes = { item_id: 1, delivered: true, reason: null, reason_details: null };
    const no = { item_id: 2, delivered: false, reason: NonDeliveryReason.other, reason_details: 'x' };

    it('derives the outcome from the answers only', () => {
        expect(outcomeOf([yes, yes])).toBe(AttemptOutcome.delivered);
        expect(outcomeOf([no, no])).toBe(AttemptOutcome.not_delivered);
        expect(outcomeOf([yes, no])).toBe(AttemptOutcome.partially_delivered);
    });
});

describe('validateRecipient', () => {
    const customer = { customer_name: 'ישראל ישראלי', customer_id_number: '012345678', customer_phone: '050-1234567' };

    it('copies the customer and ignores the body fields for recipient_type customer', () => {
        const out = validateRecipient({ recipient_type: RecipientType.customer, recipient_name: 'someone else' }, customer);
        expect(out).toEqual({ type: RecipientType.customer, name: customer.customer_name, id_number: customer.customer_id_number, phone: customer.customer_phone });
    });

    it('requires all three fields for another person', () => {
        expect400(() => validateRecipient({ recipient_type: RecipientType.other, recipient_id_number: '123456', recipient_phone: '0521111111' }, customer), 'recipient_name');
        expect400(() => validateRecipient({ recipient_type: RecipientType.other, recipient_name: 'רוני', recipient_id_number: '12ab', recipient_phone: '0521111111' }, customer), 'recipient_id_number');
        expect400(() => validateRecipient({ recipient_type: RecipientType.other, recipient_name: 'רוני', recipient_id_number: '123456', recipient_phone: 'call me' }, customer), 'recipient_phone');
    });

    it('rejects an unknown recipient type', () => {
        expect400(() => validateRecipient({ recipient_type: 'neighbour' }, customer), 'recipient_type');
        expect400(() => validateRecipient(undefined, customer), 'recipient_type');
    });

    it('trims and accepts a valid other person', () => {
        const out = validateRecipient({ recipient_type: RecipientType.other, recipient_name: ' רוני כהן ', recipient_id_number: '300123456', recipient_phone: '054-0000000' }, customer);
        expect(out).toEqual({ type: RecipientType.other, name: 'רוני כהן', id_number: '300123456', phone: '054-0000000' });
    });
});

describe('validateSignature', () => {
    it('accepts a real png data url', () => {
        expect(validateSignature(PNG)).toBe(PNG);
    });

    it('rejects anything that is not a png data url', () => {
        expect400(() => validateSignature(undefined), 'png data url');
        expect400(() => validateSignature('data:image/jpeg;base64,/9j/4AAQ'), 'png data url');
        expect400(() => validateSignature('data:image/png;base64,not base64!!'), 'valid base64');
    });

    it('rejects a jpeg wearing a png prefix', () => {
        const jpeg = 'data:image/png;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]).toString('base64');
        expect400(() => validateSignature(jpeg), 'not a png');
    });

    it('rejects a signature over the size limit', () => {
        const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const big = 'data:image/png;base64,' + Buffer.concat([header, Buffer.alloc(SIGNATURE_MAX_BYTES)]).toString('base64');
        expect400(() => validateSignature(big), 'larger than');
    });
});
