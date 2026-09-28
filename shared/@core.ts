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

/*──────────────────────────────────────────────────────────────────────────*/

export interface IUser {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  courier_id?: number; //filled in the jwt for courier accounts
}

export interface ICourier {
  id: number;
  name: string;
  employee_id?: string;
  phone?: string;
  email?: string;
  zones?: string[];
  active: boolean;
  user_id?: number;
  pending?: number; //open tasks, filled by /api/couriers
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
  reported_at: string;
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
