import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';

import { NonDeliveryReason } from '../../../shared/@core';
import { DETAILS_MAX, ItemAnswer, Recipient } from './attempt.validation';

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

/*──────────────────────────────────────────────────────────────────────────*/

export const CONFLICT_UNIQUE_INDEX = 'UQ_delivery_conflicts_user_operation';

export function isConflictUniqueViolation(e: any) {
  return e?.code === '23505' && e?.constraint === CONFLICT_UNIQUE_INDEX;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the answers of a rejected report, kept as evidence: the same per line rules as validateItemAnswers (a real boolean, a
//reason from the list plus details only on a "not delivered" line) but WITHOUT matching them to the issuance's current
//lines. the report was signed against the lines of that moment, and the manager may have changed the issuance since;
//the item ids are kept as submitted. the normalized shape is the one payloadHash hashes for a delivery attempt, so the
//same report hashes the same on both routes
export function validateEvidenceItems(raw: any): ItemAnswer[] {
  if (!Array.isArray(raw) || !raw.length) throw new BadRequestException('items must be a non empty array');
  if (raw.length > 100) throw new BadRequestException('too many item answers');
  const seen = new Set<number>();
  const answers: ItemAnswer[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') throw new BadRequestException('item answer must be an object');
    const id = Number(a.item_id);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException(`bad item id ${a.item_id}`);
    if (seen.has(id)) throw new BadRequestException(`duplicate answer for item ${id}`);
    seen.add(id);
    if (typeof a.delivered !== 'boolean') throw new BadRequestException(`delivered must be true or false for item ${id}`);
    if (a.delivered) {
      answers.push({ item_id: id, delivered: true, reason: null, reason_details: null });
      continue;
    }
    if (!Object.values(NonDeliveryReason).includes(a.reason)) throw new BadRequestException(`unknown reason for item ${id}`);
    const details = typeof a.reason_details === 'string' ? a.reason_details.trim() : '';
    if (!details) throw new BadRequestException(`reason details are required for item ${id}`);
    if (details.length > DETAILS_MAX) throw new BadRequestException(`reason details for item ${id} are longer than ${DETAILS_MAX} chars`);
    answers.push({ item_id: id, delivered: false, reason: a.reason, reason_details: details });
  }
  return answers;
}
