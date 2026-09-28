// shared between client and server. plain ts only - no nest / react / typeorm imports in here

export enum UserRole {
  manager = "manager",
  courier = "courier",
}

// the labels in the design: לא שובץ / ממתין / נמסר / נמסר חלקית / לא נמסר / איסוף עצמי
// "assigned" is what the courier sees as ממתין (waiting for delivery)
export enum IssuanceStatus {
  unassigned = "unassigned",
  assigned = "assigned",
  delivered = "delivered",
  partially_delivered = "partially_delivered",
  not_delivered = "not_delivered",
  self_pickup = "self_pickup",
  deleted = "deleted", //soft delete, the row stays with delete_reason
}

export enum Priority {
  normal = "normal",
  urgent = "urgent",
}

export enum TaskStatus {
  pending = "pending",
  done = "done",
  cancelled = "cancelled", //re-assigned to someone else or moved to self pickup, kept for history
}

// same string values as the matching IssuanceStatus on purpose, the issuance status mirrors the last attempt
export enum AttemptOutcome {
  delivered = "delivered",
  partially_delivered = "partially_delivered",
  not_delivered = "not_delivered",
}

// the closed list from the courier screen: אין אף אחד / כפל מוצר / כתובת לא תקינה / סירוב לקוח / אחר
export enum NonDeliveryReason {
  nobody_home = "nobody_home",
  duplicate_product = "duplicate_product",
  invalid_address = "invalid_address",
  customer_refused = "customer_refused",
  other = "other",
}

export enum RecipientType {
  customer = "customer",
  other = "other",
}

// offline courier: where a delivery report saved on the device stands with the server. a separate axis from the business
// enums above on purpose: the report is "delivered" the moment the courier signs it, whether or not the server heard yet
export enum ReportSyncState {
  queued = "queued", //saved on the device, waiting for the network
  syncing = "syncing", //a request is in flight right now
  synced = "synced", //the server acknowledged it, the ack is stored next to the report
  auth = "auth", //the server said 401, the same account has to sign in again
  invalid = "invalid", //400, the server rejected the payload. kept for attention, no automatic retry
  forbidden = "forbidden", //403 / 404, the task is not this courier's any more
  conflict = "conflict", //409, the task changed under the report (reported elsewhere, reassigned, revision moved)
}

// the `code` on a 409 from POST /api/delivery/tasks/:id/attempts, so the screen can say in hebrew what happened
export enum ReportConflictCode {
  task_closed = "task_closed", //reported already, by this device or another one
  task_cancelled = "task_cancelled", //reassigned, moved to self pickup or deleted
  issuance_not_assigned = "issuance_not_assigned",
  revision_changed = "revision_changed", //the issuance changed materially since the snapshot the report was written on
  operation_reused = "operation_reused", //same operation id, different content
}

/*──────────────────────────────────────────────────────────────────────────*/

export interface IUser {
  id: number; //users.id. the jwt calls it sub, auth.service.login returns both so the client never keys local storage on undefined
  username: string;
  display_name: string;
  role: UserRole;
  courier_id?: number; //filled in the jwt for courier accounts
}

export interface ICourier {
  id: number;
  name: string;
  employee_id?: string;
  id_number?: string; //תעודת זהות, 9 digits, the column next to the phone on the ניהול שליחים table
  phone?: string;
  email?: string;
  zones?: string[];
  active: boolean;
  user_id?: number;
  pending?: number; //open tasks, filled by /api/couriers
}

// the add / edit courier form. POST /api/couriers and PATCH /api/couriers/:id take exactly this
export interface ICourierPayload {
  name: string;
  id_number: string;
  phone: string;
}

export interface IIssuanceItem {
  id: number;
  issuance_id: number;
  line_no: number;
  product_name: string;
  catalog_number?: string; //מק"ט
  station_number?: string;
  serial_number?: string;
  quantity: number;
}

export interface IIssuance {
  id: number;
  sap_number: string;
  number_prefix?: string; //the letter before the number in the design (ס' / ד' / כ'), meaning still unknown
  status: IssuanceStatus;
  priority: Priority;
  customer_name: string;
  customer_id_number?: string;
  customer_phone?: string;
  address_street: string;
  address_building?: string;
  address_city: string;
  delivery_date?: string; //yyyy-mm-dd
  self_pickup: boolean;
  notes?: string;
  source: string;
  revision?: number; //bumped by every change that invalidates an offline delivery report (assign, self pickup, delete, a report). priority / date / notes edits leave it alone
  deleted_at?: string;
  delete_reason?: string;
  items?: IIssuanceItem[];
  tasks?: IDeliveryTask[];
  current_task?: IDeliveryTask; //derived on the server, the open task or the last closed one
  created_at?: string;
  updated_at?: string;
}

export interface IDeliveryTask {
  id: number;
  issuance_id: number;
  courier_id: number;
  status: TaskStatus;
  scheduled_date?: string;
  assigned_by?: number;
  assigned_at?: string;
  closed_at?: string;
  issuance?: IIssuance;
  courier?: ICourier;
  attempts?: IDeliveryAttempt[];
  local_report?: ILocalReportRef; //client only, set by the offline data layer when a report saved on this device overlays the server snapshot
}

// client only, never sent by the server: how the board and the detail screen know a task has a report saved on this device
export interface ILocalReportRef {
  operation_id: string;
  state: ReportSyncState;
  conflict_code?: ReportConflictCode;
  client_reported_at: string;
}

export interface IDeliveryAttemptItem {
  id?: number;
  item_id: number;
  delivered: boolean;
  reason?: NonDeliveryReason;
  reason_details?: string;
}

export interface IDeliveryAttempt {
  id: number;
  task_id: number;
  outcome: AttemptOutcome;
  recipient_type: RecipientType;
  recipient_name?: string;
  recipient_id_number?: string;
  recipient_phone?: string;
  signature_png?: string; //data url
  reported_at: string; //server receipt time
  client_reported_at?: string; //the device clock when the courier tapped send. untrusted, can be hours before reported_at after an outage
  items?: IDeliveryAttemptItem[];
}

// what the courier screen posts to /api/delivery/tasks/:id/attempts
export interface IAttemptPayload {
  recipient_type: RecipientType;
  recipient_name?: string;
  recipient_id_number?: string;
  recipient_phone?: string;
  signature_png: string;
  items: IDeliveryAttemptItem[];
  //offline queue: the same operation_id sent again is a replay of the first result, not a second attempt.
  //all three are optional, a request without them behaves exactly as before the offline work
  operation_id?: string;
  issuance_revision?: number; //IIssuance.revision the report was written against, 409 revision_changed when it moved
  client_reported_at?: string; //iso, from the device clock
}

// what POST /api/delivery/tasks/:id/attempts answers. stored with the operation, so a retry gets the same body back
export interface IAttemptResult {
  attempt_id: number;
  outcome: AttemptOutcome;
  task_id: number;
  reported_at: string;
  operation_id?: string;
  replayed?: boolean; //the server already had this operation and returned the stored result
}

/*──────────────────────────────────────────────────────────────────────────*/

// the board columns the manager can sort by. the server maps each key to sql (issuances.service.ts), the client draws
// the arrows in the table header and offers the same list on the phone
export type IssuanceSortKey = "number" | "customer" | "destination" | "city" | "courier" | "priority" | "status";
export const issuanceSortKeys: IssuanceSortKey[] = ["number", "customer", "destination", "city", "courier", "priority", "status"];

export interface ISortState {
  key: IssuanceSortKey;
  dir: "asc" | "desc";
}
