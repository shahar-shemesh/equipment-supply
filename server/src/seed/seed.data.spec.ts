import { IssuanceStatus, Priority } from '../../../shared/@core';
import { buildBulkIssuances, buildIssuances, couriers } from './seed.data';

//the generated set without a database: the shape the seed loop reads and the spread the pagination spec relies on

const taskStatuses = [IssuanceStatus.assigned, IssuanceStatus.delivered, IssuanceStatus.partially_delivered, IssuanceStatus.not_delivered];
const closedStatuses = [IssuanceStatus.delivered, IssuanceStatus.partially_delivered, IssuanceStatus.not_delivered];

describe('buildBulkIssuances', () => {
  const rows = buildBulkIssuances(2000);
  const today = new Date().toISOString().slice(0, 10);

  it('builds the asked count, nothing for 0, and leaves the handcrafted 30 alone', () => {
    expect(rows).toHaveLength(2000);
    expect(buildBulkIssuances(0)).toEqual([]);
    expect(buildIssuances()).toHaveLength(30);
  });

  it('gives the same rows on every call', () => {
    expect(buildBulkIssuances(2000)).toEqual(rows);
    //a smaller count is a prefix: the customer pool is drawn before the rows
    expect(buildBulkIssuances(50)).toEqual(rows.slice(0, 50));
  });

  it('sap numbers are digits only and unique across both sets', () => {
    const all = [...buildIssuances(), ...rows].map((r) => r.sap_number);
    expect(new Set(all).size).toBe(2030);
    for (const n of all) expect(n).toMatch(/^\d+$/);
  });

  /*──────────────────────────────────────────────────────────────────────────*/

  it('spreads status, priority, city and delivery date', () => {
    for (const s of Object.values(IssuanceStatus)) expect(rows.some((r) => r.status === s)).toBe(true);
    for (const p of Object.values(Priority)) expect(rows.some((r) => r.priority === p)).toBe(true);
    expect(new Set(rows.map((r) => r.address_city)).size).toBeGreaterThanOrEqual(15);
    expect(rows.some((r) => r.delivery_date === null)).toBe(true);
    expect(rows.some((r) => r.delivery_date && r.delivery_date < today)).toBe(true);
    expect(rows.some((r) => r.delivery_date && r.delivery_date > today)).toBe(true);
    expect(rows.every((r) => r.source === 'sample')).toBe(true);
  });

  it('a closed row was delivered on a past date', () => {
    for (const r of rows) {
      if (closedStatuses.includes(r.status) && r.delivery_date) expect(r.delivery_date < today).toBe(true);
    }
  });

  it('a courier only where the seed loop has a task to create', () => {
    const names = couriers.map((c) => c.name);
    for (const r of rows) {
      if (taskStatuses.includes(r.status)) expect(names).toContain(r.courier);
      else expect(r.courier).toBeNull();
    }
  });

  it('deleted rows look like softDelete left them, the others carry nothing of it', () => {
    for (const r of rows) {
      if (r.status === IssuanceStatus.deleted) {
        expect(r.deleted_at).toBeInstanceOf(Date);
        expect(r.delete_reason).toBeTruthy();
      } else {
        expect(r.deleted_at).toBeUndefined();
        expect(r.delete_reason).toBeUndefined();
      }
      expect(r.self_pickup).toBe(r.status === IssuanceStatus.self_pickup);
    }
  });

  it('items are numbered 1..k, one to four of them, quantity 1 to 3', () => {
    for (const r of rows) {
      expect(r.items.length).toBeGreaterThanOrEqual(r.status === IssuanceStatus.partially_delivered ? 2 : 1);
      expect(r.items.length).toBeLessThanOrEqual(4);
      expect(r.items.map((i) => i.line_no)).toEqual(r.items.map((_, k) => k + 1));
      for (const i of r.items) {
        expect(i.quantity).toBeGreaterThanOrEqual(1);
        expect(i.quantity).toBeLessThanOrEqual(3);
      }
    }
  });
});
