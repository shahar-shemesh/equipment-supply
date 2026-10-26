import { describe, expect, it } from 'vitest';

import { IssuanceStatus, Priority } from '../../../../shared/@core';
import type { LoadedIssuance, ParsedIssuance } from '../types';
import { diffIssuance, insertColumns } from './transform';

const parsed: ParsedIssuance = {
  sap_number: '2000592',
  customer_name: 'ישראל ישראלי',
  customer_phone: '050-1234567',
  address_street: 'הרצל 12',
  address_city: 'תל אביב',
  items: [
    { line_no: 1, product_name: 'מחשב', catalog_number: 'PKG-1102', quantity: 1 },
    { line_no: 2, product_name: 'מסך', quantity: 2 },
  ],
};

const row: LoadedIssuance = {
  id: 7,
  sap_number: '2000592',
  status: IssuanceStatus.unassigned,
  revision: 3,
  number_prefix: null,
  priority: Priority.normal,
  delivery_date: '2026-10-30',
  customer_name: 'ישראל ישראלי',
  customer_id_number: '012345678',
  customer_phone: '050-1234567',
  address_street: 'הרצל 12',
  address_building: null,
  address_city: 'תל אביב',
  notes: 'ישן',
  items: [
    { id: 11, line_no: 1, product_name: 'מחשב', catalog_number: 'PKG-1102', station_number: null, serial_number: null, quantity: 1, removed: false },
    { id: 12, line_no: 2, product_name: 'מסך', catalog_number: null, station_number: null, serial_number: null, quantity: 2, removed: false },
  ],
};

describe('insertColumns', () => {
  it('fills the defaults of a new issuance: priority normal, nulls for the absent optionals, quantity 1', () => {
    const { issuance, items } = insertColumns({ ...parsed, items: [{ line_no: 5, product_name: 'x' }] });
    expect(issuance).toEqual({ number_prefix: null, priority: 'normal', delivery_date: null, customer_name: 'ישראל ישראלי', customer_id_number: null, customer_phone: '050-1234567', address_street: 'הרצל 12', address_building: null, address_city: 'תל אביב', notes: null });
    expect(items).toEqual([{ line_no: 5, product_name: 'x', catalog_number: null, station_number: null, serial_number: null, quantity: 1 }]);
  });
});

describe('diffIssuance', () => {
  it('sees nothing in an identical document, absent optionals included', () => {
    const diff = diffIssuance(parsed, row);
    expect(diff).toEqual({ changed: [], patch: {}, items: { inserts: [], updates: [], removes: [] }, bumpsRevision: false });
  });

  it('bumps the revision for a customer or an address change, not for priority, date, notes or prefix', () => {
    const phone = diffIssuance({ ...parsed, customer_phone: '052-0000000' }, row);
    expect(phone.changed).toEqual(['customer_phone']);
    expect(phone.patch).toEqual({ customer_phone: '052-0000000' });
    expect(phone.bumpsRevision).toBe(true);

    const soft = diffIssuance({ ...parsed, priority: Priority.urgent, delivery_date: '2026-11-01', notes: 'חדש', number_prefix: "ס'" }, row);
    expect(soft.changed).toEqual(['number_prefix', 'priority', 'delivery_date', 'notes']);
    expect(soft.bumpsRevision).toBe(false);

    expect(diffIssuance({ ...parsed, address_building: 'קומה 2' }, row).bumpsRevision).toBe(true);
  });

  it('plans the lines: a gone line removed, a new one inserted, a changed one updated, and bumps the revision', () => {
    const diff = diffIssuance({ ...parsed, items: [{ line_no: 1, product_name: 'מחשב', catalog_number: 'PKG-1102', quantity: 3 }, { line_no: 3, product_name: 'מקלדת' }] }, row);
    expect(diff.items).toEqual({
      inserts: [{ line_no: 3, product_name: 'מקלדת', catalog_number: null, station_number: null, serial_number: null, quantity: 1 }],
      updates: [{ id: 11, line_no: 1, patch: { quantity: 3 }, restore: false }],
      removes: [{ id: 12, line_no: 2 }],
    });
    expect(diff.changed).toEqual(['items[3].inserted', 'items[1].quantity', 'items[2].removed']);
    expect(diff.bumpsRevision).toBe(true);
  });

  it('restores a removed line that comes back and leaves an absent item field alone', () => {
    const removed = { ...row, items: [row.items[0], { ...row.items[1], removed: true }] };
    const diff = diffIssuance(parsed, removed);
    expect(diff.items.updates).toEqual([{ id: 12, line_no: 2, patch: {}, restore: true }]);
    expect(diff.changed).toEqual(['items[2].restored']);
    expect(diff.bumpsRevision).toBe(true);

    //catalog_number PKG-1102 is in the row and not in the document: untouched
    const quiet = diffIssuance({ ...parsed, items: [{ line_no: 1, product_name: 'מחשב' }, { line_no: 2, product_name: 'מסך' }] }, row);
    expect(quiet.changed).toEqual([]);
  });

  it('does not remove a line that is already removed, and matches the live row when a line number is doubled', () => {
    const doubled = { ...row, items: [{ ...row.items[0], id: 10, removed: true }, row.items[0], row.items[1]] };
    const diff = diffIssuance({ ...parsed, items: [{ line_no: 2, product_name: 'מסך' }] }, doubled);
    expect(diff.items.removes).toEqual([{ id: 11, line_no: 1 }]);
    const gone = { ...row, items: [row.items[0], { ...row.items[1], removed: true }] };
    expect(diffIssuance({ ...parsed, items: [parsed.items[0]] }, gone).changed).toEqual([]);
  });
});
