import { BadRequestException } from '@nestjs/common';

//the add / edit courier form (ניהול שליחים): name, תעודת זהות, phone. checked here and not only on the screen,
//the same rows feed the assign dialog and the link to a courier login. every throw is a 400 with the reason

export const NAME_MAX = 100;

export type CourierPayload = { name: string; id_number: string; phone: string };

//9 digits and nothing else. the check digit (the luhn-like one on israeli ids) is not verified on purpose: the sample
//ids on the design screens fail it, and nobody said the couriers table must hold real ids. one line here when it must
export function normalizeIdNumber(raw: any) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length !== 9) throw new BadRequestException('id_number must be 9 digits');
  return digits;
}

/*──────────────────────────────────────────────────────────────────────────*/

//israeli numbers as people type them: 052-4438192, 0524438192, 03-5555555. stored with the dash after the prefix,
//the way the design prints them. no +972 handling, the couriers are local
export function normalizePhone(raw: any) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  const mobile = /^0[57]\d{8}$/.test(digits); //05x cellular, 07x voip
  const landline = /^0[2-4689]\d{7}$/.test(digits);
  if (!mobile && !landline) throw new BadRequestException('phone must be an israeli number (05X-XXXXXXX or 0X-XXXXXXX)');
  const prefix = mobile ? 3 : 2;
  return `${digits.slice(0, prefix)}-${digits.slice(prefix)}`;
}

/*──────────────────────────────────────────────────────────────────────────*/

export function validateCourierPayload(body: any): CourierPayload {
  if (!body || typeof body !== 'object') throw new BadRequestException('payload must be an object');
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new BadRequestException('name is required');
  if (name.length > NAME_MAX) throw new BadRequestException(`name is longer than ${NAME_MAX} chars`);
  return { name, id_number: normalizeIdNumber(body.id_number), phone: normalizePhone(body.phone) };
}
