import { BadRequestException } from '@nestjs/common';

import { AuditAction } from '../../../shared/@core';
import { parseAuditQuery, SIZE_DEFAULT, SIZE_MAX } from './audit.validation';

function expect400(q: any, contains: string) {
    let err: any;
    try {
        parseAuditQuery(q);
    } catch (e) {
        err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain(contains);
}

describe('parseAuditQuery', () => {
    it('an empty query is the first page of everything', () => {
        expect(parseAuditQuery({})).toEqual({ issuance_id: null, actor_user_id: null, action: null, from: null, to: null, page: 1, size: SIZE_DEFAULT });
        expect(parseAuditQuery(undefined).page).toBe(1);
        expect(parseAuditQuery({ issuance_id: '', action: '', from: '' })).toMatchObject({ issuance_id: null, action: null, from: null });
    });

    it('reads the filters the way the query string sends them', () => {
        const q = parseAuditQuery({ issuance_id: '5', actor_user_id: '2', action: AuditAction.issuance_assign, page: '3', size: '20' });
        expect(q).toMatchObject({ issuance_id: 5, actor_user_id: 2, action: AuditAction.issuance_assign, page: 3, size: 20 });
    });

    it('size is capped at the maximum and page starts at 1', () => {
        expect(parseAuditQuery({ size: String(SIZE_MAX) }).size).toBe(SIZE_MAX);
        expect400({ size: String(SIZE_MAX + 1) }, 'size must be');
        expect400({ size: '0' }, 'size must be');
        expect400({ page: '0' }, 'page starts at 1');
    });

    it('an action outside the closed list is a 400, not an empty page', () => {
        expect400({ action: 'issuance.explode' }, 'unknown action');
        expect400({ action: ['issuance.assign', 'issuance.edit'] }, 'unknown action');
    });

    it('ids and pages are digits only', () => {
        expect400({ issuance_id: 'abc' }, 'issuance_id must be a positive integer');
        expect400({ issuance_id: '12abc' }, 'issuance_id');
        expect400({ issuance_id: '-1' }, 'issuance_id');
        expect400({ actor_user_id: '1.5' }, 'actor_user_id');
        expect400({ page: ['1', '2'] }, 'page');
    });

    it('from and to take an iso date or date time, and a bare to covers its whole day', () => {
        const q = parseAuditQuery({ from: '2026-10-06', to: '2026-10-06' });
        expect(q.from.toISOString()).toBe('2026-10-06T00:00:00.000Z');
        expect(q.to.toISOString()).toBe('2026-10-07T00:00:00.000Z');
        expect(parseAuditQuery({ to: '2026-10-06T08:30:00Z' }).to.toISOString()).toBe('2026-10-06T08:30:00.000Z');
        expect(parseAuditQuery({ from: '2026-10-06T08:30:00+03:00' }).from.toISOString()).toBe('2026-10-06T05:30:00.000Z');
        expect400({ from: 'yesterday' }, 'from must be an iso date');
        expect400({ to: '2026-13-45' }, 'to is not a calendar date');
        expect400({ from: '06/10/2026' }, 'from must be');
    });

    it('a time without a zone is utc; a day off the calendar, an impossible hour and a window that ends first are 400s', () => {
        expect(parseAuditQuery({ from: '2026-10-06T08:30' }).from.toISOString()).toBe('2026-10-06T08:30:00.000Z');
        expect400({ from: '2026-02-30' }, 'from is not a calendar date');
        expect400({ to: '2026-04-31T10:00:00Z' }, 'to is not a calendar date');
        expect400({ from: '2026-10-06T24:00' }, 'from must be an iso date');
        expect400({ from: '2026-10-07', to: '2026-10-06' }, 'from must be before to');
        expect(parseAuditQuery({ from: '2026-10-06', to: '2026-10-06' }).to.toISOString()).toBe('2026-10-07T00:00:00.000Z');
    });

    it('an id of zero is a typo, not a filter', () => {
        expect400({ issuance_id: '0' }, 'ids start at 1');
        expect400({ actor_user_id: '000' }, 'ids start at 1');
    });
});
