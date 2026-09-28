import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

import { ItemAnswer, Recipient } from './attempt.validation';

//the offline queue on the tablet sends every report with an operation id, and the same id again after a lost response.
//everything that decides "is this the same report" lives here, the transaction in delivery.service only asks

export const OPERATION_UNIQUE_INDEX = 'UQ_delivery_operations_user_operation';

//optional: a request without it is the legacy flow. present, it has to look like an id the device made (uuid or similar),
//not free text, because it ends up in a unique index and in log lines
export function validateOperationId(raw: any): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 64 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new BadRequestException('operation_id must be 8 to 64 chars of letters, digits, _ or -');
  }
  return raw;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the issuance revision the report was written against. optional, but when it is there it must be a real integer:
//a string "3" from a sloppy client would never equal the column and every report would be a conflict
export function validateIssuanceRevision(raw: any): number | null {
  if (raw == null) return null;
  if (!Number.isInteger(raw)) throw new BadRequestException('issuance_revision must be an integer');
  return raw;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the device clock when the courier tapped send. strict iso only: Date.parse('1') is a valid date in v8 (2001), so a loose
//parse would store junk as a real time. anything else is null, never a 400, the report itself is still fine
export function parseClientTime(raw: any): Date | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) || isNaN(Date.parse(raw))) return null;
  return new Date(raw);
}

/*──────────────────────────────────────────────────────────────────────────*/

//sha256 over the VALIDATED report, in a fixed key order and with the answers sorted by item id, so a retry that trimmed a
//name differently or listed the lines in another order still hashes the same. the task id is part of it: the same
//operation id on another task is a different report
export function payloadHash(data: { task_id: number; recipient: Recipient; signature_png: string; items: ItemAnswer[] }) {
  const canonical = {
    task_id: data.task_id,
    recipient: { type: data.recipient.type, name: data.recipient.name, id_number: data.recipient.id_number, phone: data.recipient.phone },
    signature_png: data.signature_png,
    items: [...data.items].sort((a, b) => a.item_id - b.item_id).map((a) => ({ item_id: a.item_id, delivered: a.delivered, reason: a.reason, reason_details: a.reason_details })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/*──────────────────────────────────────────────────────────────────────────*/

//postgres 23505 on our unique index. QueryFailedError copies the driver props, so code and constraint are on the error itself
export function isOperationUniqueViolation(e: any) {
  return e?.code === '23505' && e?.constraint === OPERATION_UNIQUE_INDEX;
}
