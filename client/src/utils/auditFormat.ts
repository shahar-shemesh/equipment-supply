import { AuditAction, AuditActorType, AuditEntityType, IAuditEntry, ReportConflictCode, UserRole } from "../../../shared/@core";
import { priorityKeys, statusKeys } from "../../../shared/@utils";
import { formatDate } from "./format";

//the t of react-i18next, handed in so this stays a set of plain functions (the specs pass their own)
export type T = (key: string, values?: Record<string, any>) => string;

export type ChangeRow = { field: string; label: string; from: string; to: string };
export type DetailRow = { key: string; label: string; value: string };

//the hebrew of every enum the log carries, by key so he.ts stays the one dictionary. an action or a type outside the
//maps (a server newer than this build) prints its raw identifier, never an empty cell
export const actionKeys: Record<AuditAction, string> = {
  [AuditAction.issuance_assign]: "audit_action_issuance_assign",
  [AuditAction.issuance_edit]: "audit_action_issuance_edit",
  [AuditAction.issuance_self_pickup]: "audit_action_issuance_self_pickup",
  [AuditAction.issuance_self_pickup_report]: "audit_action_issuance_self_pickup_report",
  [AuditAction.issuance_mark_urgent]: "audit_action_issuance_mark_urgent",
  [AuditAction.issuance_remove_item]: "audit_action_issuance_remove_item",
  [AuditAction.issuance_delete]: "audit_action_issuance_delete",
  [AuditAction.courier_create]: "audit_action_courier_create",
  [AuditAction.courier_reactivate]: "audit_action_courier_reactivate",
  [AuditAction.courier_update]: "audit_action_courier_update",
  [AuditAction.courier_remove]: "audit_action_courier_remove",
  [AuditAction.delivery_report]: "audit_action_delivery_report",
  [AuditAction.delivery_conflict_record]: "audit_action_delivery_conflict_record",
  [AuditAction.delivery_conflict_review]: "audit_action_delivery_conflict_review",
  [AuditAction.auth_login]: "audit_action_auth_login",
  [AuditAction.auth_login_failed]: "audit_action_auth_login_failed",
  [AuditAction.system_seed]: "audit_action_system_seed",
  [AuditAction.xml_export_retry]: "audit_action_xml_export_retry",
  [AuditAction.issuance_import]: "audit_action_issuance_import",
};

export const entityKeys: Record<AuditEntityType, string> = {
  [AuditEntityType.issuance]: "audit_entity_issuance",
  [AuditEntityType.courier]: "audit_entity_courier",
  [AuditEntityType.delivery_task]: "audit_entity_delivery_task",
  [AuditEntityType.delivery_conflict]: "audit_entity_delivery_conflict",
  [AuditEntityType.user]: "audit_entity_user",
  [AuditEntityType.system]: "audit_entity_system",
};

//the fields an edit may change: EDIT_FIELDS of issuances.service and UPDATE_FIELDS of couriers.service on the server.
//the import's "changed" list names issuance columns too, and the columns of a line behind items[n]. (fieldLabel), so
//the customer, the address and the line columns are here as well
const fieldKeys: Record<string, string> = {
  priority: "audit_field_priority",
  delivery_date: "audit_field_delivery_date",
  notes: "audit_field_notes",
  name: "audit_field_name",
  employee_id: "audit_field_employee_id",
  id_number: "audit_field_id_number",
  phone: "audit_field_phone",
  email: "audit_field_email",
  zones: "audit_field_zones",
  customer_name: "audit_field_customer_name",
  customer_id_number: "audit_field_customer_id_number",
  customer_phone: "audit_field_customer_phone",
  address_street: "audit_field_address_street",
  address_building: "audit_field_address_building",
  address_city: "audit_field_address_city",
  product_name: "audit_field_product_name",
  catalog_number: "audit_field_catalog_number",
  station_number: "audit_field_station_number",
  serial_number: "audit_field_serial_number",
  quantity: "audit_field_quantity",
};

//a touched line in the import's "changed" list (etls/issuance-xml-import, transform.ts): items[3].inserted,
//items[2].removed, items[2].restored or items[1].quantity, by the line number printed on the SAP document
const LINE_RE = /^items\[(\d+)\]\.(\w+)$/;
const lineEvents: Record<string, string> = { inserted: "audit_line_inserted", removed: "audit_line_removed", restored: "audit_line_restored" };

//every other key the services write into details (grep "audit.record" on the server and the import etl). a key that is
//not here prints as itself
const detailKeys: Record<string, string> = {
  courier_id: "audit_detail_courier_id",
  task_id: "audit_detail_task_id",
  scheduled_date: "audit_detail_scheduled_date",
  from_status: "audit_detail_from_status",
  from_priority: "audit_detail_from_priority",
  reason: "audit_detail_reason",
  attempt_id: "audit_detail_attempt_id",
  outcome: "audit_detail_outcome",
  operation_id: "audit_detail_operation_id",
  items_delivered: "audit_detail_items_delivered",
  items_total: "audit_detail_items_total",
  revision: "audit_detail_revision",
  rejection_code: "audit_detail_rejection_code",
  submitted_revision: "audit_detail_submitted_revision",
  review_version: "audit_detail_review_version",
  item_id: "audit_detail_item_id",
  line_no: "audit_detail_line_no",
  product_name: "audit_detail_product_name",
  items_left: "audit_detail_items_left",
  name: "audit_detail_name",
  employee_id: "audit_detail_employee_id",
  users: "audit_detail_users",
  couriers: "audit_detail_couriers",
  issuances: "audit_detail_issuances",
  event_id: "audit_detail_event_id",
  sequence: "audit_detail_sequence",
  previous_attempts: "audit_detail_previous_attempts",
  last_error: "audit_detail_last_error",
  sap_number: "audit_detail_sap_number",
  mode: "audit_detail_mode",
  changed: "audit_detail_changed",
  file: "audit_detail_file",
  document_id: "audit_detail_document_id",
  revision_bumped: "audit_detail_revision_bumped",
};

//the keys whose values are not plain text: a yyyy-mm-dd day, an issuance status, a priority
const dateKeys = new Set(["delivery_date", "scheduled_date"]);
const statusKeySet = new Set(["from_status", "outcome"]);
const priorityKeySet = new Set(["priority", "from_priority"]);
const conflictCodes = new Set<string>(Object.values(ReportConflictCode));
const roles = new Set<string>(Object.values(UserRole));

/*──────────────────────────────────────────────────────────────────────────*/

export function actionLabel(action: string, t: T) {
  const key = actionKeys[action as AuditAction];
  return key ? t(key) : action;
}

export function entityTypeLabel(type: string, t: T) {
  const key = entityKeys[type as AuditEntityType];
  return key ? t(key) : type;
}

export function fieldLabel(field: string, t: T): string {
  //"שורה 2 הוסרה", "שורה 1: מוצר"; a line column this build does not know keeps its name after the line
  const line = LINE_RE.exec(field);
  if (line) return lineEvents[line[2]] ? t(lineEvents[line[2]], { n: line[1] }) : t("audit_line_field", { n: line[1], field: fieldLabel(line[2], t) });
  return fieldKeys[field] ? t(fieldKeys[field]) : field;
}

function detailLabel(key: string, t: T) {
  return detailKeys[key] ? t(detailKeys[key]) : fieldLabel(key, t);
}

export function roleLabel(role: string, t: T) {
  return roles.has(role) ? t(`role_${role}`) : role;
}

/*──────────────────────────────────────────────────────────────────────────*/

//who did it: the user's current name, else the username copied on the row (a deleted account), else the system, else
//the bare id. the login rows of the seed's manager read the same as her other rows
export function actorLabel(entry: IAuditEntry, t: T) {
  if (entry.actor_name) return entry.actor_name;
  if (entry.actor_username) return entry.actor_username;
  if (entry.actor_type === AuditActorType.system) return t("audit_actor_system");
  return entry.actor_user_id != null ? `#${entry.actor_user_id}` : "-";
}

//the issuance column: the number, or the id when the issuance is gone, or nothing on a row that concerns none
export function issuanceLabel(entry: IAuditEntry) {
  if (entry.issuance_number) return entry.issuance_number;
  return entry.issuance_id != null ? `#${entry.issuance_id}` : "";
}

//the "מזהה ישות" cell next to the type: what the manager knows the row's entity by. an issuance and the rows about one
//(a delivery, a rejected report) by the issuance number, a courier by name, a login by its account; the bare id when the
//page resolved no name, nothing for the system
export function entityIdLabel(entry: IAuditEntry, t: T) {
  const id = entry.entity_id != null ? `#${entry.entity_id}` : "";
  switch (entry.entity_type) {
    case AuditEntityType.issuance:
    case AuditEntityType.delivery_task:
    case AuditEntityType.delivery_conflict:
      return issuanceLabel(entry) || id;
    case AuditEntityType.courier:
      return entry.courier_name || id;
    case AuditEntityType.user:
      //the login rows: the entity is the actor
      return entry.entity_id === entry.actor_user_id ? actorLabel(entry, t) : id;
    case AuditEntityType.system:
      return "";
    default:
      return id;
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//one value of details as text, by the key it sits under. null and "" are "ריק", a day prints DD/MM/YYYY, a status or a
//priority prints its label, an array joins, anything nested prints as json rather than [object Object]
export function formatValue(key: string, value: any, t: T): string {
  if (value === null || value === undefined || value === "") return t("audit_value_empty");
  if (Array.isArray(value)) return value.length ? value.map((v) => formatValue(key, v, t)).join(", ") : t("audit_value_empty");
  if (typeof value === "boolean") return t(value ? "yes" : "no");
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  if (dateKeys.has(key) && /^\d{4}-\d{2}-\d{2}/.test(s)) return formatDate(s);
  if (statusKeySet.has(key) && statusKeys[s]) return t(statusKeys[s]);
  if (priorityKeySet.has(key) && priorityKeys[s]) return t(priorityKeys[s]);
  if (key === "rejection_code" && conflictCodes.has(s)) return t(`conflict_reason_${s}`);
  if (key === "mode" && (s === "insert" || s === "update")) return t(`audit_import_${s}`);
  if (key === "changed") return fieldLabel(s, t);
  return s;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the before / after table of an edit, from details.changes = { field: { from, to } }. a value that is not that shape
//(nothing the server writes today) still becomes a row, its text in the "to" column
export function changeRows(entry: IAuditEntry, t: T): ChangeRow[] {
  const changes = entry.details?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  return Object.entries(changes).map(([field, change]) => {
    const c: any = change && typeof change === "object" && !Array.isArray(change) ? change : { from: undefined, to: change };
    return { field, label: fieldLabel(field, t), from: formatValue(field, c.from, t), to: formatValue(field, c.to, t) };
  });
}

//every detail key but the changes, as label / value. the courier id of an assign row prints the courier's name when the
//page resolved one
export function detailRows(entry: IAuditEntry, t: T): DetailRow[] {
  const details = entry.details;
  if (!details || typeof details !== "object") return [];
  return Object.entries(details)
    .filter(([key]) => key !== "changes")
    .map(([key, value]) => ({
      key,
      label: detailLabel(key, t),
      value: key === "courier_id" && entry.courier_name ? entry.courier_name : formatValue(key, value, t),
    }));
}

/*──────────────────────────────────────────────────────────────────────────*/

//the one line of the row: the summary key of the action filled from details. a value the row does not carry (an older
//row, a row written by hand) falls back to the action label instead of a sentence with a hole in it
export function summary(entry: IAuditEntry, t: T): string {
  const d: Record<string, any> = entry.details && typeof entry.details === "object" ? entry.details : {};
  const fallback = actionLabel(entry.action, t);
  const fill = (key: string, values: Record<string, any>) => (Object.values(values).some((v) => v == null || v === "") ? fallback : t(key, values));
  const status = (v: any) => (statusKeys[v] ? t(statusKeys[v]) : v);
  const changed = changeRows(entry, t).map((r) => r.label).join(", ");

  switch (entry.action) {
    case AuditAction.issuance_assign: {
      const courier = entry.courier_name || (d.courier_id != null ? `#${d.courier_id}` : null);
      return d.scheduled_date ? fill("audit_summary_assign_dated", { courier, date: formatValue("scheduled_date", d.scheduled_date, t) }) : fill("audit_summary_assign", { courier });
    }
    case AuditAction.issuance_edit:
    case AuditAction.courier_update:
      return fill("audit_summary_changed", { fields: changed });
    case AuditAction.issuance_self_pickup: {
      //a field edit sent along with the move rides on the same row
      const line = fill("audit_summary_self_pickup", { from: status(d.from_status) });
      return changed ? `${line}, ${t("audit_summary_changed", { fields: changed })}` : line;
    }
    case AuditAction.issuance_self_pickup_report:
    case AuditAction.delivery_report:
      return fill("audit_summary_delivery", { outcome: status(d.outcome), delivered: d.items_delivered, total: d.items_total });
    case AuditAction.issuance_mark_urgent:
      return t("audit_summary_mark_urgent");
    case AuditAction.issuance_remove_item:
      return fill("audit_summary_remove_item", { product: d.product_name, left: d.items_left });
    case AuditAction.issuance_delete:
      return d.reason ? fill("audit_summary_delete_reason", { from: status(d.from_status), reason: d.reason }) : fill("audit_summary_delete", { from: status(d.from_status) });
    case AuditAction.courier_create:
      return fill("audit_summary_courier_create", { name: d.name || entry.courier_name });
    case AuditAction.courier_reactivate:
      return fill("audit_summary_courier_reactivate", { name: d.name || entry.courier_name });
    case AuditAction.courier_remove:
      return fill("audit_summary_courier_remove", { name: d.name || entry.courier_name });
    case AuditAction.delivery_conflict_record:
      return d.rejection_code ? formatValue("rejection_code", d.rejection_code, t) : fallback;
    case AuditAction.delivery_conflict_review:
      return t("audit_summary_conflict_review");
    case AuditAction.system_seed:
      return fill("audit_summary_seed", { issuances: d.issuances, couriers: d.couriers, users: d.users });
    case AuditAction.xml_export_retry:
      return fill("audit_summary_xml_retry", { sequence: d.sequence, attempts: d.previous_attempts });
    case AuditAction.issuance_import: {
      if (d.mode !== "update") return fill("audit_summary_import_insert", { document: d.document_id });
      const fields = Array.isArray(d.changed) && d.changed.length ? formatValue("changed", d.changed, t) : null;
      return fill("audit_summary_import_update", { document: d.document_id, fields });
    }
    default:
      //the logins and anything this build does not know
      return fallback;
  }
}
