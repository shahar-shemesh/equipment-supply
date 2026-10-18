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
  not_a_conflict = "not_a_conflict", //only from POST .../conflicts: the report could still be applied, so nothing is recorded as evidence
}

// the code on the 403 of every courier operation of an account that holds no courier row (server/src/delivery/
// courier-identity.service.ts). the tablet stops its worker on it and keeps its queue as it is until the identity is
// refreshed (client/src/courier/offline/sync.ts)
export const COURIER_UNLINKED_CODE = "courier_unlinked";

// where the evidence of a rejected report stands: on the device only, on its way, kept on the server for the manager,
// or looked at by the manager. never a delivery state: a reviewed report was still not applied
export enum ConflictReviewStatus {
  pending = "pending",
  reviewed = "reviewed",
}

// client side axis of a rejected report, next to ReportSyncState (which stays `conflict` the whole time)
export enum EvidenceUploadState {
  none = "none", //saved only on this device (rows written before the evidence upload existed look like this)
  pending = "pending", //waiting to send for manager review
  uploading = "uploading",
  received = "received", //the server acknowledged the evidence, the manager can see it
  reviewed = "reviewed", //a manager marked it reviewed. the delivery report was not applied
  failed = "failed", //the server refused the evidence upload (400 / 403 / 404 / 409), kept for attention
}

/*──────────────────────────────────────────────────────────────────────────*/

// which login the server runs (AUTH_MODE, read in server/src/env.ts). the client asks GET /api/auth/mode instead of
// guessing from its own build
export enum AuthMode {
  mock = "mock", //a signed jwt for one of the two predefined identities below, no password. LOCAL and test boxes only
  cognito = "cognito", //the real identity provider (Entra ID through AWS Cognito), a documented boundary until it is wired
}

// the two buttons of the login page in mock mode. the server maps each key to a seeded users row
// (server/src/auth/mock/mock-identities.ts) and derives everything else from it
export enum MockIdentity {
  manager = "manager",
  courier = "courier",
}

// the signed in person, as req.user on the server and as the stored session on the client. roles come from the server
// only (rolesOf in shared/auth.ts): a manager holds the courier role too and opens the courier screens without a second
// login. the jwt keeps the id under sub, the server maps it back here
export interface IAuthUser {
  id: number; //users.id
  username: string;
  name: string;
  email: string | null;
  roles: UserRole[];
  courier_id: number | null; //the couriers row linked to this user, null when there is none (the delivery routes answer 403)
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
  removed_at?: string | null; //set when the manager took the line off the issuance; such a line is left out of every issuance and task load
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
  revision?: number; //bumped by every change that invalidates an offline delivery report (assign, self pickup, delete, a line removed, a report). priority / date / notes edits leave it alone
  deleted_at?: string;
  delete_reason?: string;
  items?: IIssuanceItem[];
  tasks?: IDeliveryTask[];
  current_task?: IDeliveryTask; //derived on the server, the open task or the last closed one; null while the status is self_pickup
  delivered_by_user_id?: number | null; //the manager who handed over at the warehouse (self pickup), null for a courier delivery
  delivered_by_name?: string | null; //that manager's display name, derived on the server; the board shows it where the courier would be
  created_at?: string;
  updated_at?: string;
}

export interface IDeliveryTask {
  id: number;
  issuance_id: number;
  courier_id: number | null; //null for a self pickup handover task, closed by the manager at the warehouse
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
  //null when nothing was handed over (outcome not_delivered): no one received, so there is no recipient and no signature
  recipient_type: RecipientType | null;
  recipient_name?: string | null;
  recipient_id_number?: string | null;
  recipient_phone?: string | null;
  signature_png?: string | null; //data url
  reported_at: string; //server receipt time
  client_reported_at?: string; //the device clock when the courier tapped send. untrusted, can be hours before reported_at after an outage
  items?: IDeliveryAttemptItem[];
}

// what the courier screen posts to /api/delivery/tasks/:id/attempts
export interface IAttemptPayload {
  //required when at least one line was delivered. when every line is "not delivered" there is no one to sign, and the
  //recipient and the signature are left out (null / empty); the server stores nulls then
  recipient_type: RecipientType | null;
  recipient_name?: string;
  recipient_id_number?: string;
  recipient_phone?: string;
  signature_png: string | null;
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

// what POST /api/delivery/tasks/:id/conflicts answers when the rejected report was kept as evidence. `kind` tells it
// apart from an IAttemptResult: the same route answers { kind: "delivered", ...IAttemptResult } when that operation had
// in fact been applied, so a device that lost the first response never files a false conflict
export interface IConflictReceipt {
  kind: "conflict_recorded";
  conflict_id: number;
  operation_id: string;
  task_id: number;
  received_at: string;
  review_status: ConflictReviewStatus;
  reviewed_at?: string | null;
  replayed?: boolean;
}

// the authoritative state the server saw when it recorded the evidence, frozen with it
export interface IConflictObserved {
  task_status: TaskStatus;
  issuance_status: IssuanceStatus;
  issuance_revision: number;
  current_task_id: number | null; //the open task of the issuance at that moment, if any
  current_courier_id: number | null;
  attempt_id: number | null; //the attempt that closed the rejected report's task, if any
}

// a rejected report kept on the server (delivery_conflicts). the submitted content never changes after the insert;
// review_* are the manager's administrative acknowledgment and change nothing about the delivery
export interface IDeliveryConflict {
  id: number;
  operation_id: string;
  user_id: number;
  courier_id: number;
  task_id: number;
  issuance_id: number;
  submitted_revision?: number | null;
  recipient_type: RecipientType | null; //null when the signed report delivered nothing, same rule as a delivery attempt
  recipient_name?: string | null;
  recipient_id_number?: string | null;
  recipient_phone?: string | null;
  items: IDeliveryAttemptItem[];
  signature_png?: string | null; //only in the detail response
  rejection_code: ReportConflictCode;
  rejection_message?: string;
  observed: IConflictObserved;
  client_reported_at?: string | null;
  received_at: string;
  review_status: ConflictReviewStatus;
  reviewed_by?: number | null;
  reviewed_by_name?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  review_version: number; //optimistic token of the review action, sent back with POST .../review
  courier?: ICourier;
  issuance?: IIssuance;
}

// GET /api/delivery/conflicts?operation_ids= for the courier: the review status of their own evidence
export interface IConflictStatus {
  operation_id: string;
  conflict_id: number;
  received_at: string;
  review_status: ConflictReviewStatus;
  reviewed_at?: string | null;
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

/*──────────────────────────────────────────────────────────────────────────*/

// the audit log (audit_log): one row per committed state change, written inside the transaction of the change itself and
// readable by a manager through GET /api/audit. a closed list on purpose: a new action is named here first and then
// recorded explicitly in the service that performs it, nothing is logged by an interceptor
export enum AuditActorType {
  user = "user",
  system = "system", //the seed today, the SAP interface when it exists
}

export enum AuditEntityType {
  issuance = "issuance",
  courier = "courier",
  delivery_task = "delivery_task",
  delivery_conflict = "delivery_conflict",
  user = "user",
  system = "system",
}

export enum AuditAction {
  issuance_assign = "issuance.assign",
  issuance_edit = "issuance.edit",
  issuance_self_pickup = "issuance.self_pickup",
  issuance_self_pickup_report = "issuance.self_pickup_report", //the manager handed over at the warehouse
  issuance_mark_urgent = "issuance.mark_urgent",
  issuance_remove_item = "issuance.remove_item", //one SAP line taken off the document
  issuance_delete = "issuance.delete",
  courier_create = "courier.create",
  courier_reactivate = "courier.reactivate", //a deleted courier added again under the same id number
  courier_update = "courier.update",
  courier_remove = "courier.remove",
  delivery_report = "delivery.report",
  delivery_conflict_record = "delivery.conflict_record",
  delivery_conflict_review = "delivery.conflict_review",
  auth_login = "auth.login",
  auth_login_failed = "auth.login_failed", //the one rejected request that is recorded
  system_seed = "system.seed",
  xml_export_retry = "xml_export.retry", //a manager sent a failed xml export back to the queue
}

// one row of audit_log. the actor is copied at write time (no foreign key to users), so the row reads the same after a
// rename or a delete. details holds ids and short scalars only: never a signature, a password hash or a whole payload
export interface IAuditEntry {
  id: number;
  at: string;
  actor_type: AuditActorType;
  actor_user_id: number | null;
  actor_username: string | null;
  actor_role: UserRole | null;
  action: AuditAction;
  entity_type: AuditEntityType;
  entity_id: number | null;
  issuance_id: number | null; //set on every row that concerns an issuance, the delivery and conflict rows included
  batch_id: string | null; //shared by the rows of one bulk action (assign, mark urgent, remove couriers)
  details: Record<string, any> | null;
}

// GET /api/audit?issuance_id=&actor_user_id=&action=&from=&to=&page=&size=  -  newest first
export interface IAuditPage {
  items: IAuditEntry[];
  total: number;
}

/*──────────────────────────────────────────────────────────────────────────*/

// the xml export (xml_outbox): one row per committed issuance status change, written inside the transaction of the change
// like the audit row, and exported to S3 as one xml document by the worker in server/src/xml-export. the row is a
// snapshot, everything the document needs is in it. at least once processing, one artifact per event: a row may be
// claimed twice (a lease that expired), the object key is the same both times
export enum XmlOutboxStatus {
  pending = "pending", //waiting for the worker, or for next_retry_at after a transient failure
  processing = "processing", //claimed by a worker until lease_until
  completed = "completed", //the object is in the bucket
  failed = "failed", //out of attempts, or a permanent error (the document could not be built, another object under the key); a manager retries it
}

// one row of xml_outbox as GET /api/xml-export shows it: the columns of the table, the payload itself stays inside
export interface IXmlExportEvent {
  id: string; //uuid, the EventId of the document
  issuance_id: number;
  sequence: number; //1, 2, 3... per issuance, in the order the changes committed
  previous_status: IssuanceStatus;
  new_status: IssuanceStatus;
  trigger: AuditAction; //the action that moved the status
  status: XmlOutboxStatus;
  attempts: number;
  next_retry_at: string;
  created_at: string;
  occurred_at: string;
  lease_until: string | null;
  processed_at: string | null;
  s3_key: string | null;
  content_sha256: string | null;
  last_error: string | null; //"category: message", the last failure; cleared on completion
}

// GET /api/xml-export  -  the queue at a glance and the rows that need a manager. retry_waiting are the pending rows
// whose next_retry_at is still ahead, lease_expired the processing rows a worker left behind (reclaimed on the next tick)
export interface IXmlExportOverview {
  counts: { pending: number; processing: number; completed: number; failed: number; retry_waiting: number; lease_expired: number };
  failed: IXmlExportEvent[];
}
