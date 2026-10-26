import { AuditAction, AuditActorType, AuditEntityType, IssuanceStatus } from '../../../../shared/@core';
import type { IssuanceColumns, ItemColumns, ItemPlan } from '../services/transform';
import type { LoadedIssuance, LoadedItem } from '../types';
import type { Queryable } from './db';

//issuances, issuance_items and audit_log through raw sql, every call on the file's transaction client. the lock comes
//first (SELECT ... FOR UPDATE on the issuance row, the repo's order: issuance, then its tasks; the import touches no
//task), then the writes. updated_at is set by hand: the server's @UpdateDateColumn is typeorm's doing, not the
//database's. never a DELETE, never status, self_pickup, deleted_at or delivered_by_user_id: the system owns those

const ISSUANCE_COLUMNS = 'id, sap_number, status, revision, number_prefix, priority, delivery_date::text AS delivery_date, customer_name, customer_id_number, customer_phone, address_street, address_building, address_city, notes';

export type AuditInput = {
  issuance_id: number;
  batch_id: string;
  details: { sap_number: string; mode: 'insert' | 'update'; changed: string[]; file: string; document_id: string; revision_bumped?: boolean };
};

/*──────────────────────────────────────────────────────────────────────────*/

export const issuancesRepository = {
  //every existing row of the file at once, in id order (postgres locks the rows in the order they come out of the
  //sort), before the per issuance lock below re-takes each one: the deadlock guard against the server's bulk actions
  async lockAllBySapNumbers(client: Queryable, sapNumbers: string[]): Promise<void> {
    if (!sapNumbers.length) return;
    await client.query('SELECT id FROM issuances WHERE sap_number = ANY($1::text[]) ORDER BY id FOR UPDATE', [sapNumbers]);
  },

  //the row under FOR UPDATE with all its item rows, the removed ones included (a line that comes back is restored)
  async lockBySapNumber(client: Queryable, sapNumber: string): Promise<LoadedIssuance | null> {
    const { rows } = await client.query<Omit<LoadedIssuance, 'items'>>(`SELECT ${ISSUANCE_COLUMNS} FROM issuances WHERE sap_number = $1 FOR UPDATE`, [sapNumber]);
    const row = rows[0];
    if (!row) return null;
    const items = await client.query<LoadedItem>(
      'SELECT id, line_no, product_name, catalog_number, station_number, serial_number, quantity, (removed_at IS NOT NULL) AS removed FROM issuance_items WHERE issuance_id = $1 ORDER BY line_no, id',
      [row.id],
    );
    return { ...row, items: items.rows };
  },

  async insert(client: Queryable, sapNumber: string, cols: IssuanceColumns, items: ItemColumns[]): Promise<number> {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO issuances (sap_number, number_prefix, status, priority, customer_name, customer_id_number, customer_phone, address_street, address_building, address_city, delivery_date, notes, source, revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'sap', 1) RETURNING id`,
      [sapNumber, cols.number_prefix, IssuanceStatus.unassigned, cols.priority, cols.customer_name, cols.customer_id_number, cols.customer_phone, cols.address_street, cols.address_building, cols.address_city, cols.delivery_date, cols.notes],
    );
    const id = rows[0].id;
    for (const item of items) await insertItem(client, id, item);
    return id;
  },

  //the patch may be empty when only the lines changed: updated_at and the revision still move
  async update(client: Queryable, id: number, patch: Partial<IssuanceColumns>, bumpRevision: boolean): Promise<void> {
    const sets: string[] = ['updated_at = now()'];
    const values: unknown[] = [id];
    for (const [field, value] of Object.entries(patch)) {
      values.push(value);
      sets.push(`${field} = $${values.length}`);
    }
    if (bumpRevision) sets.push('revision = revision + 1');
    await client.query(`UPDATE issuances SET ${sets.join(', ')} WHERE id = $1`, values);
  },

  async applyItems(client: Queryable, issuanceId: number, plan: ItemPlan): Promise<void> {
    for (const item of plan.inserts) await insertItem(client, issuanceId, item);
    for (const u of plan.updates) {
      const sets: string[] = [];
      const values: unknown[] = [u.id];
      for (const [field, value] of Object.entries(u.patch)) {
        values.push(value);
        sets.push(`${field} = $${values.length}`);
      }
      if (u.restore) sets.push('removed_at = NULL');
      await client.query(`UPDATE issuance_items SET ${sets.join(', ')} WHERE id = $1`, values);
    }
    if (plan.removes.length) await client.query('UPDATE issuance_items SET removed_at = now() WHERE id = ANY($1::int[]) AND removed_at IS NULL', [plan.removes.map((r) => r.id)]);
  },

  //one row per inserted or updated issuance, the system as the actor, the file row as the batch (audit-log.entity.ts:
  //the rows of one bulk action share it). details hold the sap number, the mode and the column names, no values
  async audit(client: Queryable, input: AuditInput): Promise<void> {
    await client.query(
      `INSERT INTO audit_log (actor_type, actor_user_id, actor_username, actor_role, action, entity_type, entity_id, issuance_id, batch_id, details)
       VALUES ($1, NULL, NULL, NULL, $2, $3, $4, $4, $5, $6::jsonb)`,
      [AuditActorType.system, AuditAction.issuance_import, AuditEntityType.issuance, input.issuance_id, input.batch_id, JSON.stringify(input.details)],
    );
  },
};

export type IssuancesRepository = typeof issuancesRepository;

/*──────────────────────────────────────────────────────────────────────────*/

async function insertItem(client: Queryable, issuanceId: number, item: ItemColumns) {
  await client.query('INSERT INTO issuance_items (issuance_id, line_no, product_name, catalog_number, station_number, serial_number, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    issuanceId,
    item.line_no,
    item.product_name,
    item.catalog_number,
    item.station_number,
    item.serial_number,
    item.quantity,
  ]);
}
