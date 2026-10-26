import { Priority } from '../../../../shared/@core';
import type { LoadedIssuance, LoadedItem, ParsedIssuance, ParsedItem } from '../types';

//the parsed document to the column objects, and the diff against a loaded row. the rules of the plan: a present
//element wins, an absent optional element leaves the column alone, a new issuance gets the defaults (priority
//normal, quantity 1). the revision (issuance.entity.ts: the concurrency token of an offline delivery report) is
//bumped when the customer, the address or the items changed, the things a signed report was written against; a
//priority, a delivery date, the notes or the number prefix leave it alone, like the manager's edit does

export type IssuanceColumns = {
  number_prefix: string | null;
  priority: Priority;
  delivery_date: string | null;
  customer_name: string;
  customer_id_number: string | null;
  customer_phone: string | null;
  address_street: string;
  address_building: string | null;
  address_city: string;
  notes: string | null;
};

export type ItemColumns = {
  line_no: number;
  product_name: string;
  catalog_number: string | null;
  station_number: string | null;
  serial_number: string | null;
  quantity: number;
};

export type ItemUpdate = { id: number; line_no: number; patch: Partial<Omit<ItemColumns, 'line_no'>>; restore: boolean };
export type ItemPlan = { inserts: ItemColumns[]; updates: ItemUpdate[]; removes: { id: number; line_no: number }[] };

//changed holds the column names of the issuance and one entry per touched line: items[3].inserted,
//items[2].removed, items[2].restored, items[1].quantity. it goes into the audit row as it is
export type IssuanceDiff = { changed: string[]; patch: Partial<IssuanceColumns>; items: ItemPlan; bumpsRevision: boolean };

const SCALAR_FIELDS = ['number_prefix', 'priority', 'delivery_date', 'customer_name', 'customer_id_number', 'customer_phone', 'address_street', 'address_building', 'address_city', 'notes'] as const;
const ITEM_FIELDS = ['product_name', 'catalog_number', 'station_number', 'serial_number', 'quantity'] as const;
export const REVISION_FIELDS: ReadonlySet<string> = new Set(['customer_name', 'customer_id_number', 'customer_phone', 'address_street', 'address_building', 'address_city']);

/*──────────────────────────────────────────────────────────────────────────*/

export function insertColumns(p: ParsedIssuance): { issuance: IssuanceColumns; items: ItemColumns[] } {
  return {
    issuance: {
      number_prefix: p.number_prefix ?? null,
      priority: p.priority ?? Priority.normal,
      delivery_date: p.delivery_date ?? null,
      customer_name: p.customer_name,
      customer_id_number: p.customer_id_number ?? null,
      customer_phone: p.customer_phone ?? null,
      address_street: p.address_street,
      address_building: p.address_building ?? null,
      address_city: p.address_city,
      notes: p.notes ?? null,
    },
    items: p.items.map(itemColumns),
  };
}

function itemColumns(item: ParsedItem): ItemColumns {
  return {
    line_no: item.line_no,
    product_name: item.product_name,
    catalog_number: item.catalog_number ?? null,
    station_number: item.station_number ?? null,
    serial_number: item.serial_number ?? null,
    quantity: item.quantity ?? 1,
  };
}

/*──────────────────────────────────────────────────────────────────────────*/

export function diffIssuance(p: ParsedIssuance, row: LoadedIssuance): IssuanceDiff {
  const changed: string[] = [];
  const patch: Partial<IssuanceColumns> = {};
  for (const field of SCALAR_FIELDS) {
    const next = p[field];
    if (next === undefined || next === row[field]) continue;
    (patch as Record<string, unknown>)[field] = next;
    changed.push(field);
  }

  const items = planItems(p.items, row.items);
  for (const i of items.inserts) changed.push(`items[${i.line_no}].inserted`);
  for (const u of items.updates) {
    if (u.restore) changed.push(`items[${u.line_no}].restored`);
    for (const field of Object.keys(u.patch)) changed.push(`items[${u.line_no}].${field}`);
  }
  for (const r of items.removes) changed.push(`items[${r.line_no}].removed`);

  const bumpsRevision = changed.some((c) => REVISION_FIELDS.has(c) || c.startsWith('items['));
  return { changed, patch, items, bumpsRevision };
}

//lines match by line_no. a present line updates its row (a removed row is restored with it), a live row whose line
//is not in the document is removed, a line without a row is inserted. the table has no unique on (issuance_id,
//line_no); should a seeded issuance hold two rows for one line, the live one is the match and the other is left alone
function planItems(parsed: ParsedItem[], rows: LoadedItem[]): ItemPlan {
  const byLine = new Map<number, LoadedItem>();
  for (const row of rows) {
    const current = byLine.get(row.line_no);
    if (!current || (current.removed && !row.removed)) byLine.set(row.line_no, row);
  }

  const plan: ItemPlan = { inserts: [], updates: [], removes: [] };
  const present = new Set<number>();
  for (const item of parsed) {
    present.add(item.line_no);
    const row = byLine.get(item.line_no);
    if (!row) {
      plan.inserts.push(itemColumns(item));
      continue;
    }
    const patch: ItemUpdate['patch'] = {};
    for (const field of ITEM_FIELDS) {
      const next = item[field];
      if (next === undefined || next === row[field]) continue;
      (patch as Record<string, unknown>)[field] = next;
    }
    if (row.removed || Object.keys(patch).length) plan.updates.push({ id: row.id, line_no: row.line_no, patch, restore: row.removed });
  }
  for (const row of byLine.values()) {
    if (!row.removed && !present.has(row.line_no)) plan.removes.push({ id: row.id, line_no: row.line_no });
  }
  return plan;
}
