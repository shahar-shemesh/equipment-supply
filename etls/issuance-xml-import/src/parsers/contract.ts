//the inbound document. provisional like the outbound one (server/src/xml-export/xml-builder.service.ts): nobody on the
//sap side has seen it, the namespace and the version are the system's own draft, and a document that carries another
//version is refused rather than guessed at. README open decision 17 lists what is undecided. the element names and
//the limits here are the whole contract; the parser (xml-parser.ts) refuses anything else by name

export const NAMESPACE = 'urn:equipment-supply:issuance-import';
export const SCHEMA_VERSION = '0.1-provisional';
export const ROOT = 'IssuanceImport';

//the children each element may hold, in document order. an element outside its list is refused with its path
export const ROOT_CHILDREN = ['DocumentId', 'GeneratedAt', 'Issuances'] as const;
export const ISSUANCE_CHILDREN = ['SapNumber', 'NumberPrefix', 'Priority', 'DeliveryDate', 'Customer', 'Address', 'Notes', 'Items'] as const;
export const CUSTOMER_CHILDREN = ['Name', 'IdNumber', 'Phone'] as const;
export const ADDRESS_CHILDREN = ['Street', 'Building', 'City'] as const;
export const ITEM_CHILDREN = ['LineNo', 'ProductName', 'CatalogNumber', 'StationNumber', 'SerialNumber', 'Quantity'] as const;

//the status is the system's: a document that tries to set it is refused with this wording, not as an unknown element
export const STATUS_ELEMENT = 'Status';

export const LIMITS = {
  documentId: 100,
  sapNumber: 20,
  numberPrefix: 10,
  customerName: 200,
  idNumber: 40,
  phone: 40,
  street: 200,
  building: 200,
  city: 200,
  notes: 500, //the manager's edit route refuses more (issuances.service.ts), an imported note must stay editable
  itemsMin: 1,
  itemsMax: 500,
  productName: 200,
  catalogNumber: 100,
  stationNumber: 100,
  serialNumber: 100,
  quantityMax: 100000,
  lineNoMax: 2147483647, //int4, the column's type
} as const;

export const DOCUMENT_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
export const SAP_NUMBER_RE = /^\d{1,20}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
//iso 8601 with a date, a time to the minute at least and an offset or z: what the sap side's export is expected to write
export const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
