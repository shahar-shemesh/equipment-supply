import { describe, expect, it } from "vitest";

import { AuditAction, AuditActorType, AuditEntityType, IAuditEntry, ReportConflictCode, UserRole } from "../../../shared/@core";
import { he } from "../../../shared/i18n/he";
import { actionLabel, actorLabel, changeRows, detailRows, entityIdLabel, entityTypeLabel, formatValue, issuanceLabel, roleLabel, summary } from "./auditFormat";

//the real dictionary with i18next's interpolation done by hand, so the assertions read like the screen. an unknown key
//comes back as itself, the way i18next answers one
const t = (key: string, values?: Record<string, any>) => {
  const text = (he as Record<string, string>)[key];
  if (text === undefined) return key;
  return values ? text.replace(/{{(\w+)}}/g, (_, name) => String(values[name])) : text;
};

const base: IAuditEntry = {
  id: 1, at: "2026-10-28T08:00:00.000Z", actor_type: AuditActorType.user, actor_user_id: 1, actor_username: "manager", actor_role: UserRole.manager,
  action: AuditAction.issuance_edit, entity_type: AuditEntityType.issuance, entity_id: 7, issuance_id: 7, batch_id: null, details: null,
  actor_name: "דנה לוי", issuance_number: "7000001", courier_name: null,
};
const row = (over: Partial<IAuditEntry>): IAuditEntry => ({ ...base, ...over });

/*──────────────────────────────────────────────────────────────────────────*/

describe("labels", () => {
  it("prints the hebrew of a known action, type or role, and the raw identifier of one this build does not know", () => {
    expect(actionLabel(AuditAction.issuance_assign, t)).toBe("שיוך משנע");
    expect(actionLabel("issuance.explode", t)).toBe("issuance.explode");
    expect(entityTypeLabel(AuditEntityType.delivery_conflict, t)).toBe("דוח לבדיקה");
    expect(entityTypeLabel("thing", t)).toBe("thing");
    expect(roleLabel(UserRole.courier, t)).toBe("משנע");
    expect(roleLabel("auditor", t)).toBe("auditor");
  });

  it("names the actor by the current display name, then the copied username, then the system, then the id", () => {
    expect(actorLabel(base, t)).toBe("דנה לוי");
    expect(actorLabel(row({ actor_name: null }), t)).toBe("manager");
    expect(actorLabel(row({ actor_name: null, actor_username: null, actor_user_id: null, actor_type: AuditActorType.system }), t)).toBe("מערכת");
    expect(actorLabel(row({ actor_name: null, actor_username: null, actor_user_id: 9 }), t)).toBe("#9");
    expect(actorLabel(row({ actor_name: null, actor_username: null, actor_user_id: null }), t)).toBe("-");
  });

  it("the issuance column: the number, the id when the issuance is gone, nothing on a row about none", () => {
    expect(issuanceLabel(base)).toBe("7000001");
    expect(issuanceLabel(row({ issuance_number: null }))).toBe("#7");
    expect(issuanceLabel(row({ issuance_number: null, issuance_id: null }))).toBe("");
  });

  it("the entity cell: the issuance number (for the rows about one too), the courier's name, the login's account, the id without a name, nothing for the system", () => {
    expect(entityIdLabel(base, t)).toBe("7000001");
    expect(entityIdLabel(row({ issuance_number: null }), t)).toBe("#7");
    expect(entityIdLabel(row({ entity_type: AuditEntityType.delivery_task, entity_id: 5 }), t)).toBe("7000001");
    expect(entityIdLabel(row({ entity_type: AuditEntityType.delivery_conflict, entity_id: 5, issuance_id: null, issuance_number: null }), t)).toBe("#5");
    expect(entityIdLabel(row({ entity_type: AuditEntityType.courier, entity_id: 3, courier_name: "דני כהן" }), t)).toBe("דני כהן");
    expect(entityIdLabel(row({ entity_type: AuditEntityType.courier, entity_id: 3 }), t)).toBe("#3");
    expect(entityIdLabel(row({ entity_type: AuditEntityType.user, entity_id: 1 }), t)).toBe("דנה לוי");
    expect(entityIdLabel(row({ entity_type: AuditEntityType.user, entity_id: 2 }), t)).toBe("#2");
    expect(entityIdLabel(row({ entity_type: AuditEntityType.system, entity_id: null }), t)).toBe("");
    expect(entityIdLabel(row({ entity_type: "thing" as any, entity_id: 4 }), t)).toBe("#4");
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("formatValue", () => {
  it("prints the absences as ריק and booleans as yes / no", () => {
    expect(formatValue("notes", null, t)).toBe("ריק");
    expect(formatValue("notes", undefined, t)).toBe("ריק");
    expect(formatValue("notes", "", t)).toBe("ריק");
    expect(formatValue("zones", [], t)).toBe("ריק");
    expect(formatValue("revision_bumped", true, t)).toBe("כן");
    expect(formatValue("revision_bumped", false, t)).toBe("לא");
  });

  it("prints a day as DD/MM/YYYY, a priority, a status and a rejection code by their labels, by the key the value sits under", () => {
    expect(formatValue("delivery_date", "2026-10-20", t)).toBe("20/10/2026");
    expect(formatValue("scheduled_date", "2026-10-12", t)).toBe("12/10/2026");
    expect(formatValue("notes", "2026-10-20", t)).toBe("2026-10-20"); //a note that happens to look like a date stays text
    expect(formatValue("priority", "urgent", t)).toBe("דחוף");
    expect(formatValue("from_priority", "normal", t)).toBe("רגילה");
    expect(formatValue("from_status", "assigned", t)).toBe("ממתין");
    expect(formatValue("outcome", "delivered", t)).toBe("נמסר");
    expect(formatValue("from_status", "limbo", t)).toBe("limbo");
    expect(formatValue("rejection_code", ReportConflictCode.task_cancelled, t)).toBe(he.conflict_reason_task_cancelled);
    expect(formatValue("rejection_code", "mystery", t)).toBe("mystery");
    expect(formatValue("mode", "insert", t)).toBe("הנפקה חדשה");
    expect(formatValue("mode", "merge", t)).toBe("merge");
  });

  it("joins arrays, maps the import's changed columns and lines to field names, and prints a nested object as json, never [object Object]", () => {
    expect(formatValue("zones", ["תל אביב", "חיפה"], t)).toBe("תל אביב, חיפה");
    expect(formatValue("changed", ["priority", "customer_name", "items[1].product_name"], t)).toBe("עדיפות, שם לקוח, שורה 1: מוצר");
    expect(formatValue("changed", ["items[3].inserted", "items[2].removed", "items[2].restored", "items[4].quantity", "items[4].colour", "items.x"], t)).toBe("שורה 3 נוספה, שורה 2 הוסרה, שורה 2 הוחזרה, שורה 4: כמות, שורה 4: colour, items.x");
    expect(formatValue("payload", { a: 1, b: [2] }, t)).toBe('{"a":1,"b":[2]}');
    expect(formatValue("items_total", 2, t)).toBe("2");
    expect(formatValue("items_total", 0, t)).toBe("0");
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("changeRows", () => {
  it("one row per changed field with hebrew names and values, in the order the server wrote them", () => {
    const rows = changeRows(row({ details: { changes: { priority: { from: "normal", to: "urgent" }, delivery_date: { from: null, to: "2026-10-20" }, notes: { from: "x", to: null } } } }), t);
    expect(rows).toEqual([
      { field: "priority", label: "עדיפות", from: "רגילה", to: "דחוף" },
      { field: "delivery_date", label: "מועד חלוקה", from: "ריק", to: "20/10/2026" },
      { field: "notes", label: "הערות", from: "x", to: "ריק" },
    ]);
  });

  it("a courier's zones change joins both arrays; an unknown field keeps its name", () => {
    const rows = changeRows(row({ action: AuditAction.courier_update, entity_type: AuditEntityType.courier, details: { changes: { zones: { from: ["חיפה"], to: ["חיפה", "עכו"] }, color: { from: 1, to: 2 } } } }), t);
    expect(rows).toEqual([
      { field: "zones", label: "אזורים", from: "חיפה", to: "חיפה, עכו" },
      { field: "color", label: "color", from: "1", to: "2" },
    ]);
  });

  it("a change that is not { from, to } still becomes a row, and no changes is no rows", () => {
    expect(changeRows(row({ details: { changes: { priority: "urgent" } } }), t)).toEqual([{ field: "priority", label: "עדיפות", from: "ריק", to: "דחוף" }]);
    expect(changeRows(row({ details: { changes: "junk" } }), t)).toEqual([]);
    expect(changeRows(row({ details: { changes: ["a"] } }), t)).toEqual([]);
    expect(changeRows(row({ details: { from_status: "assigned" } }), t)).toEqual([]);
    expect(changeRows(base, t)).toEqual([]);
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("detailRows", () => {
  it("every key but the changes as label / value, the courier id as the resolved name, an unknown key as itself", () => {
    const assign = row({ action: AuditAction.issuance_assign, courier_name: "דני כהן", details: { courier_id: 3, task_id: 12, scheduled_date: "2026-10-12", from_status: "unassigned", mood: "ok" } });
    expect(detailRows(assign, t)).toEqual([
      { key: "courier_id", label: "משנע", value: "דני כהן" },
      { key: "task_id", label: "מספר משימה", value: "12" },
      { key: "scheduled_date", label: "מועד מתוכנן", value: "12/10/2026" },
      { key: "from_status", label: "סטטוס קודם", value: "לא שובץ" },
      { key: "mood", label: "mood", value: "ok" },
    ]);
    expect(detailRows(row({ courier_name: null, action: AuditAction.issuance_assign, details: { courier_id: 3 } }), t)).toEqual([{ key: "courier_id", label: "משנע", value: "3" }]);
    expect(detailRows(row({ details: { changes: { priority: { from: "normal", to: "urgent" } } } }), t)).toEqual([]);
    expect(detailRows(base, t)).toEqual([]);
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("summary", () => {
  it("fills the line of the action from details and falls back to the action label when a value is missing", () => {
    expect(summary(row({ action: AuditAction.issuance_assign, courier_name: "דני כהן", details: { courier_id: 3, scheduled_date: "2026-10-12", from_status: "unassigned" } }), t)).toBe("שויכה למשנע דני כהן למועד 12/10/2026");
    expect(summary(row({ action: AuditAction.issuance_assign, details: { courier_id: 3, scheduled_date: null } }), t)).toBe("שויכה למשנע #3");
    expect(summary(row({ action: AuditAction.issuance_assign, details: {} }), t)).toBe("שיוך משנע");
    expect(summary(row({ action: AuditAction.issuance_assign, details: null }), t)).toBe("שיוך משנע");

    expect(summary(row({ details: { changes: { priority: { from: "normal", to: "urgent" }, notes: { from: null, to: "x" } } } }), t)).toBe("עודכנו: עדיפות, הערות");
    expect(summary(row({ details: { changes: {} } }), t)).toBe("עדכון פרטי הנפקה");
    expect(summary(row({ action: AuditAction.courier_update, details: { changes: { phone: { from: "1", to: "2" } } } }), t)).toBe("עודכנו: טלפון");
  });

  it("the status moves, the deliveries and the removals", () => {
    expect(summary(row({ action: AuditAction.issuance_self_pickup, details: { from_status: "assigned" } }), t)).toBe("הועברה לאיסוף עצמי מסטטוס ממתין");
    expect(summary(row({ action: AuditAction.issuance_self_pickup, details: { from_status: "unassigned", changes: { priority: { from: "normal", to: "urgent" } } } }), t)).toBe("הועברה לאיסוף עצמי מסטטוס לא שובץ, עודכנו: עדיפות");
    expect(summary(row({ action: AuditAction.delivery_report, details: { outcome: "delivered", items_delivered: 2, items_total: 2 } }), t)).toBe("נמסר: 2 מתוך 2 פריטים");
    expect(summary(row({ action: AuditAction.issuance_self_pickup_report, details: { outcome: "not_delivered", items_delivered: 0, items_total: 3 } }), t)).toBe("לא נמסר: 0 מתוך 3 פריטים");
    expect(summary(row({ action: AuditAction.issuance_mark_urgent, details: { from_priority: "normal" } }), t)).toBe("סומנה כדחופה");
    expect(summary(row({ action: AuditAction.issuance_remove_item, details: { product_name: "מקלדת", items_left: 1 } }), t)).toBe("הפריט מקלדת הוסר, נותרו 1 פריטים");
    expect(summary(row({ action: AuditAction.issuance_delete, details: { reason: "הוזמן בטעות", from_status: "self_pickup" } }), t)).toBe("נמחקה מסטטוס איסוף עצמי: הוזמן בטעות");
    expect(summary(row({ action: AuditAction.issuance_delete, details: { reason: null, from_status: "unassigned" } }), t)).toBe("נמחקה מסטטוס לא שובץ");
  });

  it("the couriers, the rejected reports, the logins, the seed, the export retry and the import", () => {
    expect(summary(row({ action: AuditAction.courier_create, details: { name: "ישראל", employee_id: null } }), t)).toBe("נוסף המשנע ישראל");
    expect(summary(row({ action: AuditAction.courier_reactivate, details: { name: "ישראל" } }), t)).toBe("המשנע ישראל הוחזר לפעילות");
    expect(summary(row({ action: AuditAction.courier_remove, details: {}, courier_name: "ישראל" }), t)).toBe("המשנע ישראל הוסר");
    expect(summary(row({ action: AuditAction.delivery_conflict_record, details: { rejection_code: ReportConflictCode.revision_changed } }), t)).toBe(he.conflict_reason_revision_changed);
    expect(summary(row({ action: AuditAction.delivery_conflict_record, details: {} }), t)).toBe("דוח שנדחה נשמר לבדיקה");
    expect(summary(row({ action: AuditAction.delivery_conflict_review, details: { review_version: 1 } }), t)).toBe("הדוח סומן כנבדק");
    expect(summary(row({ action: AuditAction.auth_login, details: null }), t)).toBe("כניסה למערכת");
    expect(summary(row({ action: AuditAction.system_seed, details: { users: 2, couriers: 6, issuances: 30 } }), t)).toBe("30 הנפקות, 6 משנעים, 2 משתמשים");
    expect(summary(row({ action: AuditAction.xml_export_retry, details: { sequence: 3, previous_attempts: 5, last_error: "x" } }), t)).toBe("אירוע 3 הוחזר לתור אחרי 5 ניסיונות");
    expect(summary(row({ action: AuditAction.issuance_import, details: { mode: "insert", document_id: "D-1", changed: [] } }), t)).toBe("נקלטה ממסמך D-1");
    expect(summary(row({ action: AuditAction.issuance_import, details: { mode: "update", document_id: "D-2", changed: ["priority", "address_city", "items[3].removed"] } }), t)).toBe("עודכנה ממסמך D-2: עדיפות, עיר, שורה 3 הוסרה");
    expect(summary(row({ action: AuditAction.issuance_import, details: { mode: "update", document_id: "D-2", changed: [] } }), t)).toBe("קליטה מ-SAP");
  });

  it("an action outside the map prints as itself and nothing throws on odd details", () => {
    expect(summary(row({ action: "issuance.explode" as any, details: { deep: { deeper: [1] } } }), t)).toBe("issuance.explode");
    expect(summary(row({ action: AuditAction.issuance_edit, details: "junk" as any }), t)).toBe("עדכון פרטי הנפקה");
  });
});
