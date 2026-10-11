import { ConflictException } from '@nestjs/common';

import { IssuanceStatus } from '../../../shared/@core';
import { assertCanDo, canDo } from './issuance.rules';

const sap = '1234567';

describe('issuance transitions', () => {
    it('a delivered issuance is closed for assign, delete and self pickup', () => {
        const delivered = { sap_number: sap, status: IssuanceStatus.delivered };
        expect(() => assertCanDo('assign', delivered)).toThrow(ConflictException);
        expect(() => assertCanDo('delete', delivered)).toThrow(ConflictException);
        expect(() => assertCanDo('self_pickup', delivered)).toThrow(ConflictException);
        expect(() => assertCanDo('edit', delivered)).toThrow(ConflictException);
    });

    it('a partially delivered issuance is frozen until the remaining items rule is decided', () => {
        const partial = { sap_number: sap, status: IssuanceStatus.partially_delivered };
        expect(canDo('assign', IssuanceStatus.partially_delivered)).toBe(false);
        expect(canDo('self_pickup', IssuanceStatus.partially_delivered)).toBe(false);
        expect(canDo('delete', IssuanceStatus.partially_delivered)).toBe(false);
        expect(() => assertCanDo('assign', partial)).toThrow(/partially_delivered, assign is not allowed/);
    });

    it('a not delivered issuance can be sent again', () => {
        expect(canDo('assign', IssuanceStatus.not_delivered)).toBe(true);
        expect(canDo('self_pickup', IssuanceStatus.not_delivered)).toBe(true);
        expect(canDo('delete', IssuanceStatus.not_delivered)).toBe(true);
    });

    it('open issuances allow everything, deleted ones allow nothing', () => {
        for (const status of [IssuanceStatus.unassigned, IssuanceStatus.assigned]) {
            expect(canDo('assign', status)).toBe(true);
            expect(canDo('self_pickup', status)).toBe(true);
            expect(canDo('delete', status)).toBe(true);
            expect(canDo('edit', status)).toBe(true);
        }
        for (const action of ['assign', 'self_pickup', 'delete', 'edit'] as const) {
            expect(canDo(action, IssuanceStatus.deleted)).toBe(false);
        }
    });

    it('self pickup can still be assigned or deleted, but not moved to self pickup again', () => {
        expect(canDo('assign', IssuanceStatus.self_pickup)).toBe(true);
        expect(canDo('delete', IssuanceStatus.self_pickup)).toBe(true);
        expect(canDo('self_pickup', IssuanceStatus.self_pickup)).toBe(false);
    });

    it('the handover report starts from self pickup only, every other status is refused', () => {
        expect(canDo('self_pickup_report', IssuanceStatus.self_pickup)).toBe(true);
        for (const status of Object.values(IssuanceStatus).filter((s) => s !== IssuanceStatus.self_pickup)) {
            expect(canDo('self_pickup_report', status)).toBe(false);
        }
        expect(() => assertCanDo('self_pickup_report', { sap_number: sap, status: IssuanceStatus.delivered })).toThrow(/delivered, self_pickup_report is not allowed/);
    });

    it('the 409 message names the issuance, the status and the action', () => {
        let message = '';
        try {
            assertCanDo('delete', { sap_number: sap, status: IssuanceStatus.deleted });
        } catch (e) {
            message = e.message;
        }
        expect(message).toBe('issuance 1234567 is deleted, delete is not allowed');
    });

    it('the 409 body carries the parts of the message, so the client can word it in hebrew', () => {
        let body: any;
        try {
            assertCanDo('assign', { sap_number: sap, status: IssuanceStatus.partially_delivered });
        } catch (e) {
            body = e.getResponse();
        }
        expect(body).toEqual({
            statusCode: 409,
            message: 'issuance 1234567 is partially_delivered, assign is not allowed',
            code: 'status_not_allowed',
            sap_number: sap,
            status: IssuanceStatus.partially_delivered,
            action: 'assign',
        });
    });
});
