import { changesBetween, snapshot } from './audit.diff';

const fields = ['priority', 'delivery_date', 'notes'];

describe('changesBetween', () => {
    it('returns null when the fields are equal, so the service writes no row', () => {
        const stored = { priority: 'normal', delivery_date: '2026-10-06', notes: null };
        expect(changesBetween(stored, { ...stored }, fields)).toBeNull();
    });

    it('lists only the fields that differ, with the old and the new value', () => {
        const before = { priority: 'normal', delivery_date: '2026-10-06', notes: 'a' };
        const after = { priority: 'urgent', delivery_date: '2026-10-06', notes: 'a' };
        expect(changesBetween(before, after, fields)).toEqual({ priority: { from: 'normal', to: 'urgent' } });
    });

    it('treats undefined and null as the same absence', () => {
        expect(changesBetween({ notes: undefined }, { notes: null }, ['notes'])).toBeNull();
        expect(changesBetween({}, { notes: 'x' }, ['notes'])).toEqual({ notes: { from: null, to: 'x' } });
        expect(changesBetween({ notes: '' }, { notes: null }, ['notes'])).toEqual({ notes: { from: '', to: null } });
    });

    it('compares dates by their day, whether they come as a Date or as yyyy-mm-dd', () => {
        expect(changesBetween({ delivery_date: new Date('2026-10-06') }, { delivery_date: '2026-10-06' }, ['delivery_date'])).toBeNull();
        expect(changesBetween({ delivery_date: '2026-10-06' }, { delivery_date: new Date('2026-10-07T10:00:00Z') }, ['delivery_date'])).toEqual({ delivery_date: { from: '2026-10-06', to: '2026-10-07' } });
        expect(changesBetween({ delivery_date: new Date('nope') }, { delivery_date: null }, ['delivery_date'])).toBeNull();
    });

    it('compares arrays by value', () => {
        expect(changesBetween({ zones: ['a', 'b'] }, { zones: ['a', 'b'] }, ['zones'])).toBeNull();
        expect(changesBetween({ zones: ['a', 'b'] }, { zones: ['b', 'a'] }, ['zones'])).toEqual({ zones: { from: ['a', 'b'], to: ['b', 'a'] } });
        expect(changesBetween({ zones: null }, { zones: [] }, ['zones'])).toEqual({ zones: { from: null, to: [] } });
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('snapshot', () => {
    it('copies the named fields so a later in place mutation does not touch the copy', () => {
        const entity = { id: 1, name: 'a', zones: ['x'], tasks: [{ id: 9 }] };
        const before = snapshot(entity, ['name', 'zones']);
        entity.name = 'b';
        entity.zones.push('y');
        expect(before).toEqual({ name: 'a', zones: ['x'] });
        expect(changesBetween(before, entity, ['name', 'zones'])).toEqual({ name: { from: 'a', to: 'b' }, zones: { from: ['x'], to: ['x', 'y'] } });
    });
});
