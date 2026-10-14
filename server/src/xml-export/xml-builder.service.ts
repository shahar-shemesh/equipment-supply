import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

import { AuditActorType, IssuanceStatus, Priority, UserRole } from '../../../shared/@core';
import { XmlOutbox } from '../entities';
import { XmlNode, serialize } from './xml';

//the contract is not written yet (README, open decision 16). the document carries this version so a consumer written
//against it can tell the day it changes
export const SCHEMA_VERSION = '0.1-provisional';
export const NAMESPACE = 'urn:equipment-supply:issuance-status-change';

//what xml-outbox.service stores in payload, everything the document needs besides the row's own columns. the issuance
//part is the state after the change. no customer name, id number, phone, address, signature or recipient: the sap side
//has the document itself, the export says what happened to it
export type XmlOutboxPayload = {
  issuance: { id: number; sap_number: string; number_prefix: string | null; priority: Priority; delivery_date: string | null; self_pickup: boolean; revision: number };
  actor: { type: AuditActorType; user_id: number | null; username: string | null; role: UserRole | null };
  details: Record<string, string | number | boolean | null>;
};

//detail keys that never reach a row, whatever the caller sends (the same idea as audit.service's dropped keys).
//the builder drops them again, so a row written by hand cannot leak them either
export const FORBIDDEN_DETAIL_KEYS = new Set(['signature_png', 'password', 'password_hash', 'customer_name', 'customer_id_number', 'customer_phone', 'address_street', 'address_building', 'address_city', 'recipient_name', 'recipient_id_number', 'recipient_phone', 'notes']);

//thrown for a row whose payload cannot become a document. the worker fails such a row at once (category xml): no retry
//fixes a corrupt payload, a manager looks at it
export class XmlBuildError extends Error {}

const STATUSES = new Set<string>(Object.values(IssuanceStatus));

/*──────────────────────────────────────────────────────────────────────────*/

//builds the document from the row and nothing else: the same row always gives the same bytes and the same hash, which
//is what makes a second upload of a reclaimed row comparable to the first
@Injectable()
export class XmlBuilderService {
  build(row: XmlOutbox): { xml: string; sha256: string } {
    const p = payloadOf(row);
    const occurredAt = row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at);
    if (isNaN(occurredAt.getTime())) throw new XmlBuildError('occurred_at is not a date');

    const doc: XmlNode = {
      name: 'IssuanceStatusChange',
      attrs: { xmlns: NAMESPACE, schemaVersion: SCHEMA_VERSION },
      children: [
        leaf('EventId', row.id),
        leaf('Sequence', row.sequence),
        leaf('OccurredAt', occurredAt.toISOString()),
        {
          name: 'Issuance',
          children: [
            leaf('Id', p.issuance.id),
            leaf('SapNumber', p.issuance.sap_number),
            leaf('NumberPrefix', p.issuance.number_prefix),
            leaf('Priority', p.issuance.priority),
            leaf('DeliveryDate', p.issuance.delivery_date),
            leaf('SelfPickup', p.issuance.self_pickup),
            leaf('Revision', p.issuance.revision),
          ],
        },
        leaf('PreviousStatus', row.previous_status),
        leaf('NewStatus', row.new_status),
        leaf('Trigger', row.trigger),
        {
          name: 'Actor',
          attrs: { type: p.actor.type },
          children: [leaf('UserId', p.actor.user_id), leaf('Username', p.actor.username), leaf('Role', p.actor.role)],
        },
        { name: 'Details', children: Object.entries(p.details).map(([k, v]) => leaf(elementName(k), v)) },
      ],
    };

    const xml = serialize(doc);
    return { xml, sha256: createHash('sha256').update(xml, 'utf8').digest('hex') };
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//a leaf element, or nothing when the value is null: the consumer reads an absent element, never an empty one
function leaf(name: string, value: string | number | boolean | null | undefined): XmlNode | null {
  if (value == null) return null;
  return { name, text: String(value) };
}

//items_delivered -> ItemsDelivered
function elementName(key: string) {
  return key
    .split('_')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

//the checks a corrupt row fails on, each with the field's name. the payload is what the service wrote, so the shape
//is not in question on a normal day; a row inserted by hand, or a future column rename, is
function payloadOf(row: XmlOutbox): XmlOutboxPayload {
  if (typeof row.id !== 'string' || !row.id) throw new XmlBuildError('id is missing');
  if (!Number.isInteger(row.sequence) || row.sequence < 1) throw new XmlBuildError('sequence is not a positive integer');
  if (!STATUSES.has(row.previous_status)) throw new XmlBuildError(`previous_status "${row.previous_status}" is not an issuance status`);
  if (!STATUSES.has(row.new_status)) throw new XmlBuildError(`new_status "${row.new_status}" is not an issuance status`);
  if (typeof row.trigger !== 'string' || !row.trigger) throw new XmlBuildError('trigger is missing');

  const p = row.payload;
  if (!p || typeof p !== 'object') throw new XmlBuildError('payload is not an object');
  const issuance = p.issuance;
  if (!issuance || typeof issuance !== 'object') throw new XmlBuildError('payload.issuance is missing');
  if (!Number.isInteger(issuance.id)) throw new XmlBuildError('payload.issuance.id is not an integer');
  if (typeof issuance.sap_number !== 'string' || !issuance.sap_number) throw new XmlBuildError('payload.issuance.sap_number is missing');
  if (!Number.isInteger(issuance.revision)) throw new XmlBuildError('payload.issuance.revision is not an integer');
  const actor = p.actor;
  if (!actor || typeof actor !== 'object' || !Object.values(AuditActorType).includes(actor.type)) throw new XmlBuildError('payload.actor.type is missing');

  const details: XmlOutboxPayload['details'] = {};
  for (const [k, v] of Object.entries(p.details || {})) {
    if (FORBIDDEN_DETAIL_KEYS.has(k)) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new XmlBuildError(`payload.details.${k} is not a detail name`);
    if (v != null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new XmlBuildError(`payload.details.${k} is not a scalar`);
    details[k] = v as any;
  }

  return {
    issuance: {
      id: issuance.id,
      sap_number: issuance.sap_number,
      number_prefix: issuance.number_prefix ?? null,
      priority: issuance.priority ?? null,
      delivery_date: issuance.delivery_date ?? null,
      self_pickup: !!issuance.self_pickup,
      revision: issuance.revision,
    },
    actor: { type: actor.type, user_id: actor.user_id ?? null, username: actor.username ?? null, role: actor.role ?? null },
    details,
  };
}
