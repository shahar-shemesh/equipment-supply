import { BadRequestException } from '@nestjs/common';

import { AttemptOutcome, NonDeliveryReason, RecipientType } from '../../../shared/@core';

//the courier's report is the one payload that becomes legal evidence (who signed for what), so it is checked field by field
//here instead of trusting the screen. every throw is a 400 with the reason in the message

export const SIGNATURE_MAX_BYTES = 1024 * 1024; //the spec: up to 1MB per signature
export const DETAILS_MAX = 100; //the 00/100 counter under the text area in the design
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_MAGIC = 0x89504e47;

export type ItemAnswer = { item_id: number; delivered: boolean; reason: NonDeliveryReason | null; reason_details: string | null };
export type Recipient = { type: RecipientType; name: string; id_number: string; phone: string };

//exactly one answer per expected item: no missing line, no unknown id, no duplicate.
//delivered must be a real boolean. a reason belongs only to a "not delivered" line and is required there
export function validateItemAnswers(items: { id: number }[], raw: any): ItemAnswer[] {
  if (!items.length) throw new BadRequestException('issuance has no items to report on');
  if (!Array.isArray(raw)) throw new BadRequestException('items must be an array');
  if (raw.length !== items.length) throw new BadRequestException(`expected ${items.length} item answers, got ${raw.length}`);

  const known = new Set(items.map((i) => i.id));
  const seen = new Set<number>();
  const answers: ItemAnswer[] = [];

  for (const a of raw) {
    if (!a || typeof a !== 'object') throw new BadRequestException('item answer must be an object');
    const id = Number(a.item_id);
    if (!Number.isInteger(id) || !known.has(id)) throw new BadRequestException(`unknown item ${a.item_id}`);
    if (seen.has(id)) throw new BadRequestException(`duplicate answer for item ${id}`);
    seen.add(id);

    if (typeof a.delivered !== 'boolean') throw new BadRequestException(`delivered must be true or false for item ${id}`);

    if (a.delivered) {
      if (a.reason || a.reason_details) throw new BadRequestException(`item ${id} is delivered, a reason does not belong here`);
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

/*──────────────────────────────────────────────────────────────────────────*/

//nothing handed over means no one received and no one signs: a report whose every line is "not delivered" needs neither
//the recipient nor the signature. the two validators below take this flag, the callers derive it from the validated answers
export function handedOver(answers: { delivered: boolean }[]): boolean {
  return answers.some((a) => a.delivered);
}

/*──────────────────────────────────────────────────────────────────────────*/

//"הלקוח/ה" copies the customer from the issuance and ignores whatever else came in the body.
//"אדם אחר" needs all three fields, like the three required inputs on the screen.
//not required (nothing delivered): an absent or empty recipient_type is null, one that is there is checked as usual, so an
//older build of the tablet that still sends the customer along is stored as before
export function validateRecipient(raw: any, customer: { customer_name: string; customer_id_number?: string; customer_phone?: string }, required = true): Recipient | null {
  const type = raw?.recipient_type;
  if (!required && (type == null || type === '')) return null;
  if (type !== RecipientType.customer && type !== RecipientType.other) throw new BadRequestException('recipient_type must be customer or other');

  if (type === RecipientType.customer) {
    return { type, name: customer.customer_name, id_number: customer.customer_id_number || null, phone: customer.customer_phone || null };
  }

  const name = str(raw.recipient_name);
  const idNumber = str(raw.recipient_id_number);
  const phone = str(raw.recipient_phone);
  if (!name || name.length > 100) throw new BadRequestException('recipient_name is required, up to 100 chars');
  //digits only, 5 to 15. israeli ids are 9 but the customer field in the seed already has other lengths, so no stricter than that
  if (!/^\d{5,15}$/.test(idNumber)) throw new BadRequestException('recipient_id_number must be 5 to 15 digits');
  if (!/^[\d\s()+-]{7,20}$/.test(phone)) throw new BadRequestException('recipient_phone must be 7 to 20 chars of digits, spaces, +, - or ()');

  return { type, name, id_number: idNumber, phone };
}

/*──────────────────────────────────────────────────────────────────────────*/

//a png data url, valid base64, at most 1MB decoded, and it really starts with the png magic bytes so a renamed jpeg or a
//text blob cannot be stored as a signature. an empty canvas still makes a valid png, that check stays on the screen.
//not required (nothing delivered): absent or empty is null, anything else still has to be a real png
export function validateSignature(raw: any, required = true): string | null {
  if (!required && (raw == null || raw === '')) return null;
  if (typeof raw !== 'string' || !raw.startsWith(PNG_PREFIX)) throw new BadRequestException('signature_png must be a png data url');
  const b64 = raw.slice(PNG_PREFIX.length);
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new BadRequestException('signature is not valid base64');

  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > SIGNATURE_MAX_BYTES) throw new BadRequestException(`signature is larger than ${SIGNATURE_MAX_BYTES} bytes`);
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== PNG_MAGIC) throw new BadRequestException('signature is not a png');

  return raw;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the outcome is never taken from the body, only from validated answers
export function outcomeOf(answers: ItemAnswer[]): AttemptOutcome {
  const delivered = answers.filter((a) => a.delivered).length;
  if (delivered === answers.length) return AttemptOutcome.delivered;
  if (delivered === 0) return AttemptOutcome.not_delivered;
  return AttemptOutcome.partially_delivered;
}

/*──────────────────────────────────────────────────────────────────────────*/

function str(v: any) {
  return typeof v === 'string' ? v.trim() : '';
}
