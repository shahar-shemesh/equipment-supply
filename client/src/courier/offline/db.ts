import { IDBPDatabase, openDB } from "idb";

import { AttemptOutcome, EvidenceUploadState, IAttemptPayload, IAttemptResult, IDeliveryTask, RecipientType, ReportConflictCode, ReportSyncState } from "../../../../shared/@core";

//the courier's local database. one database for the device, every row carries the scope (users.id:couriers.id) in its
//key so an account never reads another account's rows. four kinds of data live here and never mix:
//  tasks / task_details  the last server snapshot (replaced whole on refresh)
//  drafts                a report the courier is still filling
//  reports               an immutable report the courier already signed, waiting for the server or rejected by it
//  meta                  readiness, refresh time, the persistent storage answer and the sync lease

export const DB_NAME = "es-courier";
export const DB_VERSION = 1;

export type MetaRow = {
  scope: string;
  user_id: number;
  courier_id: number;
  username: string;
  display_name: string;
  refreshed_at: string | null;
  ready: boolean;
  last_error: string | null;
  persistent: boolean | null;
  sync_lease?: { owner: string; until: number } | null; //the cross tab lock when web locks are missing (plain http)
};

//a row of GET /delivery/tasks?tab=all plus the board position, so the local board keeps the server order
export type TaskRow = IDeliveryTask & { scope: string; task_id: number; position: number };

//the body of GET /delivery/tasks/:id, cached when a done task was opened online (attempt items + signature)
export type TaskDetailRow = IDeliveryTask & { scope: string; task_id: number };

export type DraftRow = {
  scope: string;
  task_id: number;
  answers: Record<number, any>;
  recipient_type: RecipientType;
  recipient: { name: string; id_number: string; phone: string };
  signature_png: string;
  signature_strokes: { x: number; y: number }[][];
  updated_at: string;
};

export type ReportDisplay = {
  sap_number: string;
  number_prefix?: string;
  customer_name: string;
  customer_phone?: string;
  address_street: string;
  address_building?: string;
  address_city: string;
  items: { id: number; product_name: string; catalog_number?: string; quantity: number }[];
  recipient: { name: string; id_number: string; phone: string };
};

export type ReportSync = {
  state: ReportSyncState;
  tries: number;
  next_at: string | null;
  last_error: string | null;
  http_status: number | null;
  conflict_code: ReportConflictCode | null;
  updated_at: string;
};

//business content is frozen the moment the row is written. only `sync` and `ack` change afterwards
export type LocalReport = {
  operation_id: string;
  scope: string;
  user_id: number;
  courier_id: number;
  task_id: number;
  issuance_id: number;
  issuance_revision: number | null;
  seq: number; //Date.now() at enqueue, the send order on this device
  display: ReportDisplay;
  payload: IAttemptPayload;
  outcome: AttemptOutcome; //derived on the client like attempt.validation.outcomeOf, for display only
  client_reported_at: string;
  sync: ReportSync;
  ack: IAttemptResult | null;
  //the evidence axis of a rejected report (sync.state stays `conflict`): whether the signed report reached the server for
  //the manager to look at. rows written before this field existed have none; evidenceOf() reads them as "none"
  evidence?: ReportEvidence;
};

export type ReportEvidence = {
  state: EvidenceUploadState;
  tries: number;
  next_at: string | null;
  last_error: string | null;
  http_status: number | null;
  conflict_id: number | null; //delivery_conflicts.id from the receipt
  received_at: string | null; //server clock, from the receipt
  reviewed_at: string | null;
  updated_at: string;
};

/*──────────────────────────────────────────────────────────────────────────*/

//creates only what is missing. a future version must migrate in place (add a store, add an index, rewrite rows), never
//delete a store: a queued report that has not reached the server yet may be sitting in it
function upgrade(db: IDBPDatabase, oldVersion: number) {
  if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "scope" });
  if (!db.objectStoreNames.contains("tasks")) {
    const tasks = db.createObjectStore("tasks", { keyPath: ["scope", "task_id"] });
    tasks.createIndex("by_scope", "scope");
  }
  if (!db.objectStoreNames.contains("task_details")) db.createObjectStore("task_details", { keyPath: ["scope", "task_id"] });
  if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: ["scope", "task_id"] });
  if (!db.objectStoreNames.contains("reports")) {
    const reports = db.createObjectStore("reports", { keyPath: ["scope", "operation_id"] });
    reports.createIndex("by_scope", "scope");
    reports.createIndex("by_task", ["scope", "task_id"]);
  }
  // console.log("es-courier upgraded from", oldVersion);
}

/*──────────────────────────────────────────────────────────────────────────*/

let dbPromise: Promise<IDBPDatabase> | null = null;

//the open connection, shared by every call. the promise is dropped when the browser kills the connection (safari in the
//background, storage pressure) or when another tab wants a newer version, so the next call reopens instead of failing
//forever. rejects with a "storage_unavailable" shaped error when indexeddb cannot be opened at all
export function openCourierDb(): Promise<IDBPDatabase> {
  if (dbPromise) return dbPromise;
  const p: Promise<IDBPDatabase> = new Promise<IDBPDatabase>((resolve, reject) => {
    try {
      openDB(DB_NAME, DB_VERSION, {
        upgrade,
        terminated: () => {
          if (dbPromise === p) dbPromise = null;
        },
        blocking: () => {
          p.then((db) => db.close()).catch(() => {});
          if (dbPromise === p) dbPromise = null;
        },
      }).then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  }).catch((e) => {
    if (dbPromise === p) dbPromise = null;
    //no indexeddb at all (private mode on old safari, a webview with storage off): "unavailable", not a failed save
    throw Object.assign(new Error(e?.message || "indexeddb open failed"), { name: "InvalidStateError", cause: e });
  });
  dbPromise = p;
  return p;
}

/*──────────────────────────────────────────────────────────────────────────*/

//closes the shared connection. the next call opens it again, nothing is lost. tests use it to prove a report survives
//a close / reopen, and to let deleteDB through
export async function closeDb() {
  const p = dbPromise;
  dbPromise = null;
  if (!p) return;
  try {
    (await p).close();
  } catch (e) {
    //already gone
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//every key of one scope in a store keyed [scope, x]: an empty array sorts after every number and string in indexeddb key
//order, so [scope, []] is the upper bound. used for the scope delete on refresh, never clear() (other scopes live there)
export function scopeRange(scope: string) {
  return IDBKeyRange.bound([scope], [scope, []]);
}

/*──────────────────────────────────────────────────────────────────────────*/

//the i18n key for a failed local write. quota is the one the courier can act on (free space), "unavailable" means the
//browser gives no indexeddb at all, everything else is a plain failed save
export function storageError(e: any): "storage_quota" | "storage_unavailable" | "local_save_failed" {
  const name = e?.name || e?.target?.error?.name || e?.cause?.name;
  if (name === "QuotaExceededError") return "storage_quota";
  if (name === "InvalidStateError" || name === "UnknownError" || name === "VersionError") return "storage_unavailable";
  return "local_save_failed";
}

/*──────────────────────────────────────────────────────────────────────────*/

//one readwrite transaction, resolved only after it committed: nothing above this layer says "saved" for a write that only
//got queued. `fn` may call `abort()` to roll back on purpose (a blocked draft, a locked task) and still return or throw
//its own result; any other throw aborts the transaction and is rethrown as is
export async function writeTx<T>(stores: string[], fn: (tx: any, abort: () => void) => Promise<T>): Promise<T> {
  const db = await openCourierDb();
  const tx = db.transaction(stores, "readwrite");
  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    try {
      tx.abort();
    } catch (e) {
      //already aborted by a failed request
    }
  };
  let result: T;
  try {
    result = await fn(tx, abort);
  } catch (e) {
    abort();
    tx.done.catch(() => {});
    throw e;
  }
  try {
    await tx.done;
  } catch (e) {
    if (!aborted) throw e;
  }
  return result;
}
