import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { Priority } from '../../../../shared/@core';
import type { ParsedDocument, ParsedIssuance, ParsedItem } from '../types';
import { PermanentError } from '../utils/errors';
import { ADDRESS_CHILDREN, CUSTOMER_CHILDREN, DATE_RE, DATE_TIME_RE, DOCUMENT_ID_RE, ISSUANCE_CHILDREN, ITEM_CHILDREN, LIMITS, NAMESPACE, ROOT, ROOT_CHILDREN, SAP_NUMBER_RE, SCHEMA_VERSION, STATUS_ELEMENT } from './contract';

//bytes to a ParsedDocument, or a PermanentError that says the path (Issuances/Issuance[2]/Items/Item[1]/LineNo) and
//the rule, never the value: the message lands in a log line and a sidecar file, and a customer field must not.
//the order matters: utf-8 with a fatal decoder, then a text scan for a DOCTYPE or an ENTITY (no dtd, no entity
//expansion, before any parser sees the string), then the well-formedness check, then the parse with every value kept
//as a string (parseTagValue false: the leading zeros of a SapNumber and an IdNumber survive), then the walk that
//reads the contract. whitespace is trimmed everywhere; an optional element that is present but empty counts as
//absent, so a document cannot clear a column (README, field rules)

const ISSUANCE_PATH = `${ROOT}.Issuances.Issuance`;
const ITEM_PATH = `${ISSUANCE_PATH}.Items.Item`;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  //only the two repeatable elements become arrays; a repeated DocumentId then shows up as an array and is refused
  isArray: (_name, jpath) => jpath === ISSUANCE_PATH || jpath === ITEM_PATH,
});

type Node = unknown;
type Branch = Record<string, Node>;

/*──────────────────────────────────────────────────────────────────────────*/

export function parseDocument(bytes: Buffer): ParsedDocument {
  const text = decode(bytes);
  //a comment or a cdata section may quote the words; a declaration cannot hide in either, so they are blanked out of
  //the scan (not out of the document: the parser still reads the cdata as text)
  const scanned = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (/<!DOCTYPE/i.test(scanned) || /<!ENTITY/i.test(scanned)) throw new PermanentError('a DOCTYPE or an ENTITY declaration is not accepted');

  const valid = XMLValidator.validate(text, { allowBooleanAttributes: false });
  //the code and the position only: the validator's own message quotes the character or the tag it stopped at, which
  //may be a piece of a customer field
  if (valid !== true) throw new PermanentError(`malformed xml at line ${valid.err.line}, column ${valid.err.col} (${valid.err.code})`);

  let tree: Branch;
  try {
    tree = parser.parse(text);
  } catch (e) {
    throw new PermanentError(`malformed xml: ${(e as Error).message}`, { cause: e });
  }

  const rootNames = Object.keys(tree);
  if (rootNames.length !== 1 || rootNames[0] !== ROOT) throw new PermanentError(`the root element must be ${ROOT}`);
  const root = branch(tree[ROOT], ROOT, ROOT_CHILDREN, ['xmlns', 'schemaVersion']);
  if (root.attrs.xmlns !== NAMESPACE) throw new PermanentError(`${ROOT} xmlns must be ${NAMESPACE}`);
  if (root.attrs.schemaVersion !== SCHEMA_VERSION) throw new PermanentError(`${ROOT} schemaVersion must be ${SCHEMA_VERSION}`);

  const document_id = text1(root.children.DocumentId, 'DocumentId', { required: true, max: LIMITS.documentId })!;
  if (!DOCUMENT_ID_RE.test(document_id)) throw new PermanentError('DocumentId may hold up to 100 letters, digits, ".", "_", ":" and "-"');
  const generated_at = text1(root.children.GeneratedAt, 'GeneratedAt', { required: true, max: 40 })!;
  if (!DATE_TIME_RE.test(generated_at) || isNaN(Date.parse(generated_at))) throw new PermanentError('GeneratedAt must be an ISO 8601 date and time');

  const issuancesNode = root.children.Issuances;
  if (issuancesNode === undefined) throw new PermanentError('Issuances is required');
  const issuances = branch(issuancesNode, 'Issuances', ['Issuance']);
  const list = listOf(issuances.children.Issuance);
  if (list.length < 1) throw new PermanentError('Issuances must hold at least one Issuance');

  const seen = new Map<string, number>();
  const parsed = list.map((node, i) => {
    const path = `Issuances/Issuance[${i + 1}]`;
    const issuance = parseIssuance(node, path);
    const first = seen.get(issuance.sap_number);
    if (first !== undefined) throw new PermanentError(`${path}/SapNumber duplicates Issuance[${first + 1}]`);
    seen.set(issuance.sap_number, i);
    return issuance;
  });

  return { document_id, generated_at, issuances: parsed };
}

/*──────────────────────────────────────────────────────────────────────────*/

function parseIssuance(node: Node, path: string): ParsedIssuance {
  const b = branch(node, path, ISSUANCE_CHILDREN, [], STATUS_ELEMENT);
  const c = b.children;

  const sap_number = text1(c.SapNumber, `${path}/SapNumber`, { required: true, max: LIMITS.sapNumber })!;
  if (!SAP_NUMBER_RE.test(sap_number)) throw new PermanentError(`${path}/SapNumber must be 1 to 20 digits`);

  const priorityRaw = text1(c.Priority, `${path}/Priority`, { max: 20 });
  if (priorityRaw !== undefined && priorityRaw !== Priority.normal && priorityRaw !== Priority.urgent) throw new PermanentError(`${path}/Priority must be ${Priority.normal} or ${Priority.urgent}`);

  const delivery_date = text1(c.DeliveryDate, `${path}/DeliveryDate`, { max: 10 });
  if (delivery_date !== undefined && !isRealDate(delivery_date)) throw new PermanentError(`${path}/DeliveryDate must be a real date as yyyy-mm-dd`);

  if (c.Customer === undefined) throw new PermanentError(`${path}/Customer is required`);
  const customer = branch(c.Customer, `${path}/Customer`, CUSTOMER_CHILDREN).children;
  if (c.Address === undefined) throw new PermanentError(`${path}/Address is required`);
  const address = branch(c.Address, `${path}/Address`, ADDRESS_CHILDREN).children;

  if (c.Items === undefined) throw new PermanentError(`${path}/Items is required`);
  const items = listOf(branch(c.Items, `${path}/Items`, ['Item']).children.Item);
  if (items.length < LIMITS.itemsMin || items.length > LIMITS.itemsMax) throw new PermanentError(`${path}/Items must hold between ${LIMITS.itemsMin} and ${LIMITS.itemsMax} Item elements`);

  const lines = new Map<number, number>();
  const parsedItems = items.map((item, i) => {
    const itemPath = `${path}/Items/Item[${i + 1}]`;
    const parsed = parseItem(item, itemPath);
    const first = lines.get(parsed.line_no);
    if (first !== undefined) throw new PermanentError(`${itemPath}/LineNo duplicates Item[${first + 1}]`);
    lines.set(parsed.line_no, i);
    return parsed;
  });

  return compact({
    sap_number,
    number_prefix: text1(c.NumberPrefix, `${path}/NumberPrefix`, { max: LIMITS.numberPrefix }),
    priority: priorityRaw as Priority | undefined,
    delivery_date,
    customer_name: text1(customer.Name, `${path}/Customer/Name`, { required: true, max: LIMITS.customerName })!,
    customer_id_number: text1(customer.IdNumber, `${path}/Customer/IdNumber`, { max: LIMITS.idNumber }),
    customer_phone: text1(customer.Phone, `${path}/Customer/Phone`, { max: LIMITS.phone }),
    address_street: text1(address.Street, `${path}/Address/Street`, { required: true, max: LIMITS.street })!,
    address_building: text1(address.Building, `${path}/Address/Building`, { max: LIMITS.building }),
    address_city: text1(address.City, `${path}/Address/City`, { required: true, max: LIMITS.city })!,
    notes: text1(c.Notes, `${path}/Notes`, { max: LIMITS.notes }),
    items: parsedItems,
  });
}

function parseItem(node: Node, path: string): ParsedItem {
  const c = branch(node, path, ITEM_CHILDREN).children;
  const lineRaw = text1(c.LineNo, `${path}/LineNo`, { required: true, max: 10 })!;
  if (!/^\d+$/.test(lineRaw) || +lineRaw < 1 || +lineRaw > LIMITS.lineNoMax) throw new PermanentError(`${path}/LineNo must be a positive whole number`);
  const quantityRaw = text1(c.Quantity, `${path}/Quantity`, { max: 10 });
  if (quantityRaw !== undefined && (!/^\d+$/.test(quantityRaw) || +quantityRaw < 1 || +quantityRaw > LIMITS.quantityMax)) throw new PermanentError(`${path}/Quantity must be a whole number between 1 and ${LIMITS.quantityMax}`);

  return compact({
    line_no: +lineRaw,
    product_name: text1(c.ProductName, `${path}/ProductName`, { required: true, max: LIMITS.productName })!,
    catalog_number: text1(c.CatalogNumber, `${path}/CatalogNumber`, { max: LIMITS.catalogNumber }),
    station_number: text1(c.StationNumber, `${path}/StationNumber`, { max: LIMITS.stationNumber }),
    serial_number: text1(c.SerialNumber, `${path}/SerialNumber`, { max: LIMITS.serialNumber }),
    quantity: quantityRaw === undefined ? undefined : +quantityRaw,
  });
}

/*──────────────────────────────────────────────────────────────────────────*/

//a container element: an object whose keys are its children, with no text of its own and no attributes beyond the
//ones allowed (the root's two). an empty element parses as '' and counts as a container with no children; a repeated
//one as an array. a child outside the list is refused by name; the status element gets its own wording
function branch(node: Node, path: string, allowed: readonly string[], allowedAttrs: readonly string[] = [], refusedByName: string | null = null): { children: Branch; attrs: Record<string, string> } {
  if (Array.isArray(node)) throw new PermanentError(`${path} appears more than once`);
  if (node === '') return { children: {}, attrs: {} };
  if (typeof node !== 'object' || node === null) throw new PermanentError(`${path} must hold elements, not text`);
  const children: Branch = {};
  const attrs: Record<string, string> = {};
  //paths start under the root: Issuances/Issuance[2]/..., not IssuanceImport/Issuances/...
  const child = (key: string) => (path === ROOT ? key : `${path}/${key}`);
  for (const [key, value] of Object.entries(node as Branch)) {
    if (key === '#text') throw new PermanentError(`${path} must hold elements, not text`);
    if (key.startsWith('@_')) {
      const name = key.slice(2);
      if (!allowedAttrs.includes(name)) throw new PermanentError(`${path} has an attribute ${name} that is not part of the document`);
      attrs[name] = String(value);
      continue;
    }
    if (key === refusedByName) throw new PermanentError(`${child(key)} is not accepted, the system owns the status`);
    if (!allowed.includes(key)) throw new PermanentError(`${child(key)} is not part of the document`);
    children[key] = value;
  }
  return { children, attrs };
}

//a leaf element: a trimmed string, or undefined for an absent or empty optional one. an element with attributes or
//children parses as an object and is refused; a repeated one as an array
function text1(node: Node, path: string, rule: { required?: boolean; max: number }): string | undefined {
  if (node === undefined) {
    if (rule.required) throw new PermanentError(`${path} is required`);
    return undefined;
  }
  if (Array.isArray(node)) throw new PermanentError(`${path} appears more than once`);
  if (typeof node !== 'string') throw new PermanentError(`${path} must hold text only`);
  const value = node.trim();
  if (value === '') {
    if (rule.required) throw new PermanentError(`${path} is required`);
    return undefined;
  }
  if (value.length > rule.max) throw new PermanentError(`${path} must be at most ${rule.max} characters`);
  return value;
}

function listOf(node: Node): Node[] {
  if (node === undefined) return [];
  return Array.isArray(node) ? node : [node];
}

//yyyy-mm-dd that exists in the calendar: 2026-02-30 rolls over in Date and is refused here
function isRealDate(s: string) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

//a fatal decoder: a latin-1 byte sequence that is not utf-8 is refused, not replaced with U+FFFD and imported as a
//customer name. a leading bom is dropped
function decode(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch (e) {
    throw new PermanentError('the file is not valid UTF-8', { cause: e });
  }
}

//drops the undefined keys so an absent optional reads as "not in the object", which is what the diff checks
function compact<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) if (obj[key] === undefined) delete obj[key];
  return obj;
}
