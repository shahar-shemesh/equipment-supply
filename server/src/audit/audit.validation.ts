import { BadRequestException } from '@nestjs/common';

import { AuditAction } from '../../../shared/@core';

//GET /api/audit?q=&issuance_id=&actor_user_id=&action=&from=&to=&order=&page=&size=. the query string is checked by hand
//like the payloads (attempt.validation.ts): a value that is not what the parameter means is a 400 with the reason, never
//a silent default, so a typo in a filter cannot read as an empty log

export const SIZE_DEFAULT = 50;
export const SIZE_MAX = 100;
export const Q_MAX = 100; //the search box of the audit screen; a longer value is a paste, not a search

export type AuditOrder = 'asc' | 'desc';
export type AuditQuery = { q: string | null; issuance_id: number | null; actor_user_id: number | null; actions: AuditAction[] | null; from: Date | null; to: Date | null; order: AuditOrder; page: number; size: number };

const actions = new Set<string>(Object.values(AuditAction));

export function parseAuditQuery(q: any): AuditQuery {
  const page = int(q?.page, 'page') ?? 1;
  if (page < 1) throw new BadRequestException('page starts at 1');
  const size = int(q?.size, 'size') ?? SIZE_DEFAULT;
  if (size < 1 || size > SIZE_MAX) throw new BadRequestException(`size must be 1 to ${SIZE_MAX}`);

  const issuance_id = int(q?.issuance_id, 'issuance_id');
  const actor_user_id = int(q?.actor_user_id, 'actor_user_id');
  if (issuance_id === 0 || actor_user_id === 0) throw new BadRequestException('ids start at 1');

  const from = date(q?.from, 'from', false);
  const to = date(q?.to, 'to', true);
  if (from && to && from >= to) throw new BadRequestException('from must be before to');

  return { q: text(q?.q), issuance_id, actor_user_id, actions: actionList(q?.action), from, to, order: order(q?.order), page, size };
}

/*──────────────────────────────────────────────────────────────────────────*/

//one action or a comma list of them (action=issuance.assign,issuance.edit), every member from the closed list. a repeated
//parameter reaches here as an array and stays a 400: the comma is the list, the screen sends nothing else. duplicates
//collapse, so "a,a" is one IN member
function actionList(raw: any): AuditAction[] | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw new BadRequestException(`unknown action ${String(raw)}`);
  const list = raw.split(',').map((s) => s.trim());
  for (const a of list) if (!actions.has(a)) throw new BadRequestException(`unknown action ${a}`);
  return Array.from(new Set(list)) as AuditAction[];
}

/*──────────────────────────────────────────────────────────────────────────*/

//the free text search, trimmed. blank is no filter, over Q_MAX characters is a 400 (the ILIKE would still run, it would
//just never match, which reads as an empty log for no visible reason)
function text(raw: any): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') throw new BadRequestException('q must be text');
  const value = raw.trim();
  if (!value) return null;
  if (value.length > Q_MAX) throw new BadRequestException(`q is at most ${Q_MAX} characters`);
  return value;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the sort direction of the timeline, the one sort the log has. absent is newest first
function order(raw: any): AuditOrder {
  if (raw == null || raw === '') return 'desc';
  if (raw !== 'asc' && raw !== 'desc') throw new BadRequestException('order must be asc or desc');
  return raw;
}

/*──────────────────────────────────────────────────────────────────────────*/

//absent or empty is null. otherwise digits only: a query string is text, and "12abc" or a repeated parameter (express
//hands an array over) is a mistake, not a number
function int(raw: any, name: string): number | null {
  if (raw == null || raw === '') return null;
  const s = typeof raw === 'number' ? String(raw) : raw;
  if (typeof s !== 'string' || !/^\d{1,9}$/.test(s)) throw new BadRequestException(`${name} must be a positive integer`);
  return +s;
}

/*──────────────────────────────────────────────────────────────────────────*/

//an iso date (yyyy-mm-dd) or a date time, both read as utc unless the value carries its own zone (a bare time would
//otherwise be the server's clock). the upper bound is exclusive, and a bare date as `to` moves to the next midnight so
//it covers the whole of that day: from=2026-10-06&to=2026-10-06 is one day. the regex keeps the shape and the probe
//keeps the calendar: v8 reads 2026-02-30 as march 2nd, which would be a silently shifted window instead of a 400
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function date(raw: any, name: string, endOfDay: boolean): Date | null {
  if (raw == null || raw === '') return null;
  const m = typeof raw === 'string' ? DATE_RE.exec(raw) : null;
  if (!m) throw new BadRequestException(`${name} must be an iso date or date time`);

  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) throw new BadRequestException(`${name} is not a calendar date`);

  const value = new Date(m[4] && !m[8] ? `${raw}Z` : raw);
  if (isNaN(value.getTime())) throw new BadRequestException(`${name} must be an iso date or date time`);
  if (endOfDay && !m[4]) value.setUTCDate(value.getUTCDate() + 1);
  return value;
}
