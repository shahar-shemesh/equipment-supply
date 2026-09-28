import { IDeliveryTask, IIssuance, IssuanceStatus, NonDeliveryReason, Priority, TaskStatus } from "./@core";

// both boards show issuances that go to the same customer + address as one collapsed row ("2 הנפקות").
// this is a display grouping only, the db has no group entity. rows keep their order, a group sits where its first row was
export function groupByAddress<T extends { issuance?: IIssuance } | IIssuance>(rows: T[]) {
    const groups: { key: string; rows: T[] }[] = [];
    for (const row of rows) {
        const i: IIssuance = (row as any).issuance ?? row;
        const key = `${i.customer_name}|${i.address_street}|${i.address_building || ""}|${i.address_city}`;
        const found = groups.find(g => g.key === key);
        if (found) {
            found.rows.push(row);
            continue;
        }
        groups.push({ key, rows: [row] });
    }
    return groups;
}

/*──────────────────────────────────────────────────────────────────────────*/

// the courier types the number as printed, sometimes with the prefix letter and a quote (ס' 1234567). keep digits only
export function normalizeSapNumber(raw: string) {
    return (raw || "").replace(/\D/g, "");
}

/*──────────────────────────────────────────────────────────────────────────*/

// used for the t() keys, so the enums and the he.ts dictionary stay in one place
export const statusKeys: Record<IssuanceStatus, string> = {
    [IssuanceStatus.unassigned]: "status_unassigned",
    [IssuanceStatus.assigned]: "status_assigned",
    [IssuanceStatus.delivered]: "status_delivered",
    [IssuanceStatus.partially_delivered]: "status_partially_delivered",
    [IssuanceStatus.not_delivered]: "status_not_delivered",
    [IssuanceStatus.self_pickup]: "status_self_pickup",
    [IssuanceStatus.deleted]: "status_deleted",
};

export const taskStatusKeys: Record<TaskStatus, string> = {
    [TaskStatus.pending]: "task_pending",
    [TaskStatus.done]: "task_done",
    [TaskStatus.cancelled]: "task_cancelled",
};

export const priorityKeys: Record<Priority, string> = {
    [Priority.normal]: "priority_normal",
    [Priority.urgent]: "priority_urgent",
};

export const reasonKeys: Record<NonDeliveryReason, string> = {
    [NonDeliveryReason.nobody_home]: "reason_nobody_home",
    [NonDeliveryReason.duplicate_product]: "reason_duplicate_product",
    [NonDeliveryReason.invalid_address]: "reason_invalid_address",
    [NonDeliveryReason.customer_refused]: "reason_customer_refused",
    [NonDeliveryReason.other]: "reason_other",
};

/*──────────────────────────────────────────────────────────────────────────*/

// mirrors the ORDER BY of DeliveryService.myTasks, so the courier board sorted from the local snapshot lands in the same
// order the server sends: status desc ('pending' > 'done' as text, the columns are varchar), priority desc (urgent before
// normal), scheduled_date asc with nulls last, id asc. a task that a queued report turned into done drops below the open ones
export function compareTasksForBoard(a: IDeliveryTask, b: IDeliveryTask) {
    if (a.status !== b.status) return a.status > b.status ? -1 : 1;
    const pa = a.issuance?.priority || "";
    const pb = b.issuance?.priority || "";
    if (pa !== pb) return pa > pb ? -1 : 1;
    const da = a.scheduled_date || "";
    const db = b.scheduled_date || "";
    if (da !== db) {
        if (!da) return 1;
        if (!db) return -1;
        return da < db ? -1 : 1;
    }
    return a.id - b.id;
}
