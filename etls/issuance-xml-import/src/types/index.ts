import type { IssuanceStatus, Priority, XmlImportErrorKind, XmlImportFileStatus } from '../../../../shared/@core';

//what the parser hands over: the document as the contract reads it, trimmed, with an absent (or empty) optional
//element as undefined. "undefined leaves the column alone" is the whole update rule, so the type keeps the distinction
//from null, which never appears here
export type ParsedItem = {
  line_no: number;
  product_name: string;
  catalog_number?: string;
  station_number?: string;
  serial_number?: string;
  quantity?: number;
};

export type ParsedIssuance = {
  sap_number: string;
  number_prefix?: string;
  priority?: Priority;
  delivery_date?: string; //yyyy-mm-dd
  customer_name: string;
  customer_id_number?: string;
  customer_phone?: string;
  address_street: string;
  address_building?: string;
  address_city: string;
  notes?: string;
  items: ParsedItem[];
};

export type ParsedDocument = {
  document_id: string;
  generated_at: string;
  issuances: ParsedIssuance[];
};

/*──────────────────────────────────────────────────────────────────────────*/

//an issuance row under FOR UPDATE with every item row, removed ones included (the import restores a removed line
//that comes back). delivery_date is read as text, so it compares with the document's yyyy-mm-dd as a string
export type LoadedItem = {
  id: number;
  line_no: number;
  product_name: string;
  catalog_number: string | null;
  station_number: string | null;
  serial_number: string | null;
  quantity: number;
  removed: boolean;
};

export type LoadedIssuance = {
  id: number;
  sap_number: string;
  status: IssuanceStatus;
  revision: number;
  number_prefix: string | null;
  priority: Priority;
  delivery_date: string | null;
  customer_name: string;
  customer_id_number: string | null;
  customer_phone: string | null;
  address_street: string;
  address_building: string | null;
  address_city: string;
  notes: string | null;
  items: LoadedItem[];
};

//one row of xml_import_files (server/src/entities/xml-import-file.entity.ts)
export type ImportFileStatus = XmlImportFileStatus;
export type ImportErrorKind = XmlImportErrorKind;

export type ImportFileRow = {
  id: string;
  content_sha256: string;
  document_id: string | null;
  file_name: string;
  size_bytes: number;
  status: ImportFileStatus;
  error_kind: ImportErrorKind | null;
  attempts: number;
  instance_id: string | null;
  lease_until: Date | null;
  started_at: Date;
  finished_at: Date | null;
  inserted: number;
  updated: number;
  unchanged: number;
  last_error: string | null;
  created_at: Date;
};

/*──────────────────────────────────────────────────────────────────────────*/

export type RunTrigger = 'auto' | 'manual';

//what one run did, the answer of POST /run and last_run of GET /status. discovered: the files the scan handed over;
//processed: the ones that reached a claim (succeeded, failed or already imported); skipped: left for a later run (a
//claim held elsewhere, a file that moved under the scan); error: the retryable failure that ended the run early, null
//when the run went through its list
export type RunSummary = {
  id: string;
  trigger: RunTrigger;
  started_at: string;
  finished_at: string | null;
  discovered: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  already_imported: number;
  error: string | null;
};

export type FileOutcome = 'succeeded' | 'failed' | 'skipped' | 'already_imported';

export type ImportCounts = { inserted: number; updated: number; unchanged: number };
