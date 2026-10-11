import { IssuanceStatus } from "./@core";

export type IssuanceAction = "assign" | "self_pickup" | "delete" | "edit" | "self_pickup_report";

// which statuses each manager action may start from. the server answers anything not listed with a 409
// (issuance.rules.ts), the manager board reads the same table to disable the button before the request.
//
// partially_delivered is in no row on purpose: nobody decided yet what happens with the lines that were already delivered.
// a new task with the remaining lines only? the courier sees all lines with the delivered ones marked? back to SAP for a new
// document? until that is answered a partially delivered issuance is frozen and the manager gets the 409 message.
// delivered is closed for good, deleted too. self_pickup can still be assigned (manager changed their mind) or deleted,
// and it is the only status the handover report (the manager hands over at the warehouse) may start from: the report
// sets the status from its outcome, so a second one finds delivered / not_delivered / partially_delivered and gets the 409
export const allowedFrom: Record<IssuanceAction, IssuanceStatus[]> = {
    assign: [IssuanceStatus.unassigned, IssuanceStatus.assigned, IssuanceStatus.not_delivered, IssuanceStatus.self_pickup],
    self_pickup: [IssuanceStatus.unassigned, IssuanceStatus.assigned, IssuanceStatus.not_delivered],
    delete: [IssuanceStatus.unassigned, IssuanceStatus.assigned, IssuanceStatus.not_delivered, IssuanceStatus.self_pickup],
    edit: [IssuanceStatus.unassigned, IssuanceStatus.assigned, IssuanceStatus.not_delivered, IssuanceStatus.self_pickup],
    self_pickup_report: [IssuanceStatus.self_pickup],
};

// priority / date / notes may change on these. mark-urgent on the board uses it to skip the closed rows
export const editableStatuses = allowedFrom.edit;

export function canDo(action: IssuanceAction, status: IssuanceStatus) {
    return allowedFrom[action].includes(status);
}

// the t() key of every action, for the hebrew wording of the 409 ("לא ניתן לבצע שיוך שליח...")
export const actionKeys: Record<IssuanceAction, string> = {
    assign: "action_assign",
    self_pickup: "action_self_pickup",
    delete: "action_delete",
    edit: "action_edit",
    self_pickup_report: "action_self_pickup_report",
};
