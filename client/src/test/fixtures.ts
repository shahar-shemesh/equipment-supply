import { IAuthUser, IDeliveryTask, IssuanceStatus, NonDeliveryReason, Priority, RecipientType, TaskStatus, UserRole } from "../../../shared/@core";
import { ReportForm } from "../courier/offline/store";
import { TOKEN_KEY } from "../utils/service";

//shared fixtures of the offline specs: a courier, a jwt the identity helpers can decode, list rows like
//GET /delivery/tasks?tab=all returns them, and a filled report form

export const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const courierUser: IAuthUser = { id: 7, username: "dan", name: "דן משנע", email: "dan@equipment.local", roles: [UserRole.courier], courier_id: 3 };
export const otherUser: IAuthUser = { id: 8, username: "gal", name: "גל משנע", email: "gal@equipment.local", roles: [UserRole.courier], courier_id: 4 };
export const SCOPE = "7:3";
export const OTHER_SCOPE = "8:4";

//an unsigned jwt with the shape the server issues (sub / courier_id / exp / username). identity.ts never verifies
export function makeToken(p: { sub: number; courier_id?: number; exp?: number; username?: string }) {
  const b64 = (o: any) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ courier_id: 3, username: "dan", exp: Math.floor(Date.now() / 1000) + 3600, ...p })}.sig`;
}

/*──────────────────────────────────────────────────────────────────────────*/

export function setToken(p: { sub: number; courier_id?: number; exp?: number } | null) {
  if (!p) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, makeToken(p));
}

/*──────────────────────────────────────────────────────────────────────────*/

type TaskOverrides = Partial<IDeliveryTask> & { sap_number?: string; customer_name?: string; address_street?: string; address_city?: string; priority?: Priority; item_count?: number; revision?: number };

//a list row: pending by default, two items, assigned status, id 100 + n for the issuance
export function makeTask(id: number, o: TaskOverrides = {}): IDeliveryTask {
  const done = o.status === TaskStatus.done;
  const items = Array.from({ length: o.item_count ?? 2 }, (_, i) => ({ id: id * 10 + i + 1, issuance_id: 100 + id, line_no: i + 1, product_name: `מוצר ${i + 1}`, catalog_number: `C${id}${i}`, quantity: 1 }));
  return {
    id,
    issuance_id: 100 + id,
    courier_id: 3,
    status: o.status ?? TaskStatus.pending,
    scheduled_date: o.scheduled_date,
    closed_at: done ? "2026-09-20T10:00:00.000Z" : undefined,
    attempts: done ? [{ id: 900 + id, task_id: id, outcome: IssuanceStatus.delivered as any, recipient_type: RecipientType.customer, recipient_name: "לקוח", reported_at: "2026-09-20T10:00:00.000Z" }] : [],
    issuance: {
      id: 100 + id,
      sap_number: o.sap_number ?? `70000${id}`,
      number_prefix: "ס'",
      status: done ? IssuanceStatus.delivered : IssuanceStatus.assigned,
      priority: o.priority ?? Priority.normal,
      customer_name: o.customer_name ?? `לקוח ${id}`,
      customer_id_number: "012345678",
      customer_phone: "050-1234567",
      address_street: o.address_street ?? `הרצל ${id}`,
      address_city: o.address_city ?? "תל אביב",
      self_pickup: false,
      source: "seed",
      revision: o.revision ?? 1,
      items,
    },
    ...(o.issuance ? { issuance: { ...o.issuance } } : {}),
  };
}

/*──────────────────────────────────────────────────────────────────────────*/

//the body of GET /delivery/tasks?tab=all for these rows
export function snapshot(rows: IDeliveryTask[]) {
  const pending = rows.filter((r) => r.status === TaskStatus.pending).length;
  return { rows, counts: { all: rows.length, pending, done: rows.length - pending } };
}

/*──────────────────────────────────────────────────────────────────────────*/

//every item delivered, customer recipient, signed
export function fullForm(task: IDeliveryTask): ReportForm {
  const answers: Record<number, any> = {};
  for (const i of task.issuance.items) answers[i.id] = { delivered: true };
  return { answers, recipient_type: RecipientType.customer, recipient: { name: "", id_number: "", phone: "" }, signature_png: PNG };
}

/*──────────────────────────────────────────────────────────────────────────*/

//first item delivered, the rest not
export function partialForm(task: IDeliveryTask): ReportForm {
  const f = fullForm(task);
  for (const i of task.issuance.items.slice(1)) f.answers[i.id] = { delivered: false, reason: NonDeliveryReason.nobody_home, reason_details: "לא היה אף אחד" };
  return f;
}

/*──────────────────────────────────────────────────────────────────────────*/

//nothing delivered
export function failedForm(task: IDeliveryTask): ReportForm {
  const f = fullForm(task);
  for (const i of task.issuance.items) f.answers[i.id] = { delivered: false, reason: NonDeliveryReason.customer_refused, reason_details: "סירב לקבל" };
  return f;
}

/*──────────────────────────────────────────────────────────────────────────*/

//a promise the test resolves by hand, for a transport that has to stay in flight
export function deferred<T>() {
  let resolve: (v: T) => void;
  let reject: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/*──────────────────────────────────────────────────────────────────────────*/

export function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}
