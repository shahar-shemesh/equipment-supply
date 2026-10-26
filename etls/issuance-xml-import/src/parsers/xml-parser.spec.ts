import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { PermanentError } from '../utils/errors';
import { parseDocument } from './xml-parser';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

//a document around one issuance, with the parts replaced per case
const HEAD = `<?xml version="1.0" encoding="UTF-8"?>\n<IssuanceImport xmlns="urn:equipment-supply:issuance-import" schemaVersion="0.1-provisional">\n<DocumentId>DOC-1</DocumentId>\n<GeneratedAt>2026-10-25T09:30:00Z</GeneratedAt>\n<Issuances>`;
const TAIL = `</Issuances>\n</IssuanceImport>`;
const ITEM = `<Items><Item><LineNo>1</LineNo><ProductName>מוצר</ProductName></Item></Items>`;
function issuance(parts: { sap?: string; before?: string; customer?: string; address?: string; items?: string; after?: string } = {}) {
  return `<Issuance><SapNumber>${parts.sap ?? '2000592'}</SapNumber>${parts.before ?? ''}<Customer>${parts.customer ?? '<Name>לקוח</Name>'}</Customer><Address>${parts.address ?? '<Street>רחוב</Street><City>עיר</City>'}</Address>${parts.items ?? ITEM}${parts.after ?? ''}</Issuance>`;
}
function doc(body: string, head = HEAD) {
  return Buffer.from(`${head}${body}${TAIL}`, 'utf8');
}
function refusal(bytes: Buffer) {
  try {
    parseDocument(bytes);
  } catch (e) {
    expect(e).toBeInstanceOf(PermanentError);
    return (e as Error).message;
  }
  throw new Error('parsed');
}

describe('parseDocument', () => {
  it('reads the fixture with two issuances: leading zeros, entities, cdata and hebrew survive, absent optionals are left out', () => {
    const d = parseDocument(fixture('valid-two-issuances.xml'));
    expect(d.document_id).toBe('SAP-DLV-2026-000123');
    expect(d.generated_at).toBe('2026-10-25T09:30:00Z');
    expect(d.issuances).toHaveLength(2);
    const [a, b] = d.issuances;
    expect(a).toEqual({
      sap_number: '2000592',
      number_prefix: "ד'",
      priority: 'normal',
      delivery_date: '2026-10-30',
      customer_name: 'ישראל ישראלי',
      customer_id_number: '012345678',
      customer_phone: '050-1234567',
      address_street: 'הרצל 12',
      address_building: 'בניין B קומה 3',
      address_city: 'תל אביב',
      notes: 'להתקשר לפני ההגעה & לעלות עם המעלית',
      items: [
        { line_no: 1, product_name: 'מחשב IEXXX', catalog_number: 'PKG-1102', station_number: '1104', serial_number: 'SN1', quantity: 1 },
        { line_no: 2, product_name: 'מסך 24"', catalog_number: 'PKG-2201', quantity: 2 },
      ],
    });
    expect(b.sap_number).toBe('0002000593');
    expect(b.priority).toBe('urgent');
    expect(b.notes).toBe('<דחוף> לפני 10:00');
    expect(b).not.toHaveProperty('delivery_date');
    expect(b).not.toHaveProperty('customer_phone');
    expect(b.items).toEqual([{ line_no: 1, product_name: 'מדפסת' }]);
  });

  it('refuses the second issuance by path and rule before anything else happens', () => {
    expect(refusal(fixture('invalid-second-issuance.xml'))).toBe('Issuances/Issuance[2]/Priority must be normal or urgent');
  });

  it('refuses a Status element with its own wording', () => {
    expect(refusal(fixture('status-element.xml'))).toBe('Issuances/Issuance[1]/Status is not accepted, the system owns the status');
  });

  it('refuses a DOCTYPE or an ENTITY before parsing, a latin-1 file, a malformed file and another namespace or version', () => {
    expect(refusal(fixture('doctype.xml'))).toBe('a DOCTYPE or an ENTITY declaration is not accepted');
    expect(refusal(Buffer.from('<!ENTITY x "y"><IssuanceImport/>'))).toContain('ENTITY');
    expect(refusal(fixture('latin1.xml'))).toBe('the file is not valid UTF-8');
    expect(refusal(fixture('malformed.xml'))).toMatch(/^malformed xml at line 8, column 5 \([A-Za-z]+\)$/);
    expect(refusal(fixture('wrong-namespace.xml'))).toBe('IssuanceImport xmlns must be urn:equipment-supply:issuance-import');
    expect(refusal(doc(issuance(), HEAD.replace('0.1-provisional', '1.0')))).toBe('IssuanceImport schemaVersion must be 0.1-provisional');
    expect(refusal(Buffer.from('<Other xmlns="urn:equipment-supply:issuance-import" schemaVersion="0.1-provisional"/>'))).toBe('the root element must be IssuanceImport');
    expect(refusal(Buffer.from('<IssuanceImport/><IssuanceImport/>'))).toBe('IssuanceImport appears more than once');
  });

  it('lets a comment or a cdata section quote the words DOCTYPE and ENTITY', () => {
    const notes = `<!-- no <!DOCTYPE here --><Notes><![CDATA[see <!DOCTYPE x> and <!ENTITY y "z">]]></Notes>`;
    const d = parseDocument(doc(issuance({ after: notes })));
    expect(d.issuances[0].notes).toBe('see <!DOCTYPE x> and <!ENTITY y "z">');
    expect(refusal(doc(issuance({ after: '<Notes>x</Notes>' }), HEAD.replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE IssuanceImport>')))).toBe('a DOCTYPE or an ENTITY declaration is not accepted');
  });

  it('accepts a bom and the special characters, and trims whitespace', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), doc(issuance({ customer: '<Name>  O&apos;Brien &amp; Sons &lt;ltd&gt;  </Name>', sap: ' 007 ' }))]);
    const d = parseDocument(bytes);
    expect(d.issuances[0].customer_name).toBe("O'Brien & Sons <ltd>");
    expect(d.issuances[0].sap_number).toBe('007');
  });

  it('refuses a duplicate SapNumber in one file and a duplicate LineNo in one issuance', () => {
    expect(refusal(doc(issuance() + issuance()))).toBe('Issuances/Issuance[2]/SapNumber duplicates Issuance[1]');
    const items = `<Items><Item><LineNo>3</LineNo><ProductName>a</ProductName></Item><Item><LineNo>3</LineNo><ProductName>b</ProductName></Item></Items>`;
    expect(refusal(doc(issuance({ items })))).toBe('Issuances/Issuance[1]/Items/Item[2]/LineNo duplicates Item[1]');
  });

  it('refuses unknown elements and attributes by name, at every level', () => {
    expect(refusal(doc(issuance({ after: '<Courier>x</Courier>' })))).toBe('Issuances/Issuance[1]/Courier is not part of the document');
    expect(refusal(doc(issuance({ customer: '<Name>a</Name><Email>x</Email>' })))).toBe('Issuances/Issuance[1]/Customer/Email is not part of the document');
    expect(refusal(doc(issuance({ address: '<Street>a</Street><City>b</City><Zip>1</Zip>' })))).toBe('Issuances/Issuance[1]/Address/Zip is not part of the document');
    expect(refusal(doc(issuance({ items: '<Items><Item><LineNo>1</LineNo><ProductName>a</ProductName><Price>1</Price></Item></Items>' })))).toBe('Issuances/Issuance[1]/Items/Item[1]/Price is not part of the document');
    expect(refusal(doc(`<Extra/>${issuance()}`, HEAD.replace('<Issuances>', '<Extra/><Issuances>')))).toBe('Extra is not part of the document');
    expect(refusal(doc(issuance(), HEAD.replace('schemaVersion=', 'x="1" schemaVersion=')))).toBe('IssuanceImport has an attribute x that is not part of the document');
    expect(refusal(doc(issuance({ customer: '<Name lang="he">a</Name>' })))).toBe('Issuances/Issuance[1]/Customer/Name must hold text only');
    expect(refusal(doc(issuance({ customer: 'just text' })))).toBe('Issuances/Issuance[1]/Customer must hold elements, not text');
    expect(refusal(doc(issuance({ before: '<Notes>a</Notes><Notes>b</Notes>' })))).toBe('Issuances/Issuance[1]/Notes appears more than once');
  });

  it('applies the field rules with the path in the message and never the value', () => {
    expect(refusal(doc(issuance(), HEAD.replace('DOC-1', 'DOC 1')))).toBe('DocumentId may hold up to 100 letters, digits, ".", "_", ":" and "-"');
    expect(refusal(doc(issuance(), HEAD.replace('<DocumentId>DOC-1</DocumentId>', '')))).toBe('DocumentId is required');
    expect(refusal(doc(issuance(), HEAD.replace('2026-10-25T09:30:00Z', '25/10/2026')))).toBe('GeneratedAt must be an ISO 8601 date and time');
    expect(refusal(doc(''))).toBe('Issuances must hold at least one Issuance');
    expect(refusal(doc(issuance({ sap: '12a' })))).toBe('Issuances/Issuance[1]/SapNumber must be 1 to 20 digits');
    expect(refusal(doc(issuance({ sap: '' })))).toBe('Issuances/Issuance[1]/SapNumber is required');
    expect(refusal(doc(issuance({ before: '<DeliveryDate>2026-02-30</DeliveryDate>' })))).toBe('Issuances/Issuance[1]/DeliveryDate must be a real date as yyyy-mm-dd');
    expect(refusal(doc(issuance({ before: '<NumberPrefix>12345678901</NumberPrefix>' })))).toBe('Issuances/Issuance[1]/NumberPrefix must be at most 10 characters');
    const secret = 'SECRET-VALUE-' + 'x'.repeat(200);
    const message = refusal(doc(issuance({ customer: `<Name>${secret}</Name>` })));
    expect(message).toBe('Issuances/Issuance[1]/Customer/Name must be at most 200 characters');
    expect(message).not.toContain('SECRET');
    expect(refusal(doc(issuance({ customer: '<Phone>1</Phone>' })))).toBe('Issuances/Issuance[1]/Customer/Name is required');
    expect(refusal(doc(issuance({ address: '<Street>a</Street>' })))).toBe('Issuances/Issuance[1]/Address/City is required');
    expect(refusal(doc(issuance({ items: '' })))).toBe('Issuances/Issuance[1]/Items is required');
    expect(refusal(doc(issuance({ items: '<Items/>' })))).toBe('Issuances/Issuance[1]/Items must hold between 1 and 500 Item elements');
    expect(refusal(doc(issuance({ items: '<Items><Item><LineNo>0</LineNo><ProductName>a</ProductName></Item></Items>' })))).toBe('Issuances/Issuance[1]/Items/Item[1]/LineNo must be a positive whole number');
    expect(refusal(doc(issuance({ items: '<Items><Item><LineNo>1</LineNo><ProductName>a</ProductName><Quantity>100001</Quantity></Item></Items>' })))).toBe('Issuances/Issuance[1]/Items/Item[1]/Quantity must be a whole number between 1 and 100000');
    expect(refusal(doc(issuance({ items: '<Items><Item><LineNo>1</LineNo></Item></Items>' })))).toBe('Issuances/Issuance[1]/Items/Item[1]/ProductName is required');
    expect(refusal(doc(issuance({ customer: '<Name>a</Name>' }).replace('</Issuance>', '<Status>delivered</Status></Issuance>')))).toContain('the system owns the status');
  });

  it('refuses 501 items and accepts 500', () => {
    const items = (n: number) => `<Items>${Array.from({ length: n }, (_, i) => `<Item><LineNo>${i + 1}</LineNo><ProductName>p</ProductName></Item>`).join('')}</Items>`;
    expect(parseDocument(doc(issuance({ items: items(500) }))).issuances[0].items).toHaveLength(500);
    expect(refusal(doc(issuance({ items: items(501) })))).toBe('Issuances/Issuance[1]/Items must hold between 1 and 500 Item elements');
  });

  it('treats an empty optional element as absent, so a document never clears a column', () => {
    const d = parseDocument(doc(issuance({ before: '<Notes></Notes><DeliveryDate/>', customer: '<Name>a</Name><Phone>  </Phone>' })));
    expect(d.issuances[0]).not.toHaveProperty('notes');
    expect(d.issuances[0]).not.toHaveProperty('delivery_date');
    expect(d.issuances[0]).not.toHaveProperty('customer_phone');
  });

  it('accepts the time zone forms of GeneratedAt and a date time with fractions', () => {
    for (const at of ['2026-10-25T09:30Z', '2026-10-25T09:30:00.123+03:00', '2026-10-25T09:30:00-05:00']) {
      expect(parseDocument(doc(issuance(), HEAD.replace('2026-10-25T09:30:00Z', at))).generated_at).toBe(at);
    }
  });
});
