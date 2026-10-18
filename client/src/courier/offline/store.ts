import { AttemptOutcome, EvidenceUploadState, IAttemptResult, IConflictReceipt, IDeliveryAttempt, IDeliveryTask, IAuthUser, RecipientType, ReportConflictCode, ReportSyncState, TaskStatus } from "../../../../shared/@core";
import { compareTasksForBoard, normalizeSapNumber } from "../../../../shared/@utils";
import { DraftRow, LocalReport, MetaRow, ReportEvidence, ReportSync, TaskDetailRow, TaskRow, openCourierDb, scopeRange, storageError, writeTx } from "./db";
import { newOperationId } from "./uuid";
import { tokenMatchesScope } from "./identity";
import { kickSync, noteBackgroundResult, offlineGet } from "./sync";

//the one place the courier screens read and write local data. every function takes the scope (identity.ts scopeOf) and
//touches only that scope's rows. the screens never open the database themselves.
//the board / task shown to the courier is the server snapshot overlaid with the reports saved on this device (overlay()),
//so a report the courier just signed closes the task on screen before the server ever hears about it

export type Tab = "all" | "pending" | "done";
export type BoardData = { rows: IDeliveryTask[]; counts: { all: number; pending: number; done: number }; ready: boolean; refreshed_at: string | null };
export type TaskData = { task: IDeliveryTask | null; detail_available: boolean; local_report: LocalReport | null; ready: boolean };
export type RefreshResult = { ok: boolean; error?: string; skipped?: boolean };
export type DraftInput = Omit<DraftRow, "scope" | "task_id" | "updated_at">;
export type ReportForm = { answers: Record<number, any>; recipient_type: RecipientType; recipient: { name: string; id_number: string; phone: string }; signature_png: string };
export type StoreEvent = { kind: "tasks" | "reports" | "drafts" | "meta" | "kick"; scope: string; remote?: boolean };
export type ScopeWork = { scope: string; username: string; display_name: string; count: number };

const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; //synced reports are pruned 30 days after the ack
let lastSeq = 0; //the seq of the last report written in this page session

//the states in which the local report speaks for the task on screen (the task shows as done with the local attempt).
//invalid / forbidden / conflict leave the snapshot alone and only add the attention chip
const ACTIVE_STATES = [ReportSyncState.queued, ReportSyncState.syncing, ReportSyncState.synced, ReportSyncState.auth];
const PENDING_STATES = [ReportSyncState.queued, ReportSyncState.syncing, ReportSyncState.auth];

//true for queued / syncing / synced / auth: the report may still reach (or has reached) the server, so it owns the task
export function isActiveState(state: ReportSyncState) {
  return ACTIVE_STATES.includes(state);
}

/*──────────────────────────────────────────────────────────────────────────*/

//the evidence axis of a report, "none" for rows written before it existed (they are uploaded like any other conflict)
export function evidenceOf(r: LocalReport): ReportEvidence {
  return r.evidence || { state: EvidenceUploadState.none, tries: 0, next_at: null, last_error: null, http_status: null, conflict_id: null, received_at: null, reviewed_at: null, updated_at: r.sync.updated_at };
}

/*──────────────────────────────────────────────────────────────────────────*/

//a rejected report the manager still has not seen: attention until a manager marks it reviewed. invalid / forbidden
//reports (the server never took them as evidence) stay attention for good
export function needsAttention(r: LocalReport) {
  if (r.sync.state === ReportSyncState.invalid || r.sync.state === ReportSyncState.forbidden) return true;
  return r.sync.state === ReportSyncState.conflict && evidenceOf(r).state !== EvidenceUploadState.reviewed;
}

/*──────────────────────────────────────────────────────────────────────────*/

//a conflict whose evidence the worker should send: not sent yet, or a retryable failure whose backoff passed
export function evidenceDue(r: LocalReport, now: number) {
  if (r.sync.state !== ReportSyncState.conflict) return false;
  const e = evidenceOf(r);
  if (e.state !== EvidenceUploadState.none && e.state !== EvidenceUploadState.pending) return false;
  return !e.next_at || Date.parse(e.next_at) <= now;
}

/*──────────────────────────────────────────────────────────────────────────*/

function assertScope(scope: string) {
  if (!scope || typeof scope !== "string") throw new Error("offline data layer called without a scope");
}

/*──────────────────────────────────────────────────────────────────────────*/

//an empty meta row for a scope that was never written (the names arrive with the first submit)
export function metaFromScope(scope: string): MetaRow {
  assertScope(scope);
  const [user_id, courier_id] = scope.split(":").map(Number);
  return { scope, user_id, courier_id, username: "", display_name: "", refreshed_at: null, ready: false, last_error: null, persistent: null, sync_lease: null };
}

/*──────────────────────────────────────────────────────────────────────────*/

//the board rows of one scope in server order, overlaid. the base of readBoard and readPendingIds
async function overlaidRows(scope: string) {
  const db = await openCourierDb();
  const [meta, rows, reports] = await Promise.all([
    db.get("meta", scope) as Promise<MetaRow | undefined>,
    db.getAllFromIndex("tasks", "by_scope", scope) as Promise<TaskRow[]>,
    db.getAllFromIndex("reports", "by_scope", scope) as Promise<LocalReport[]>,
  ]);
  const byTask = pickReports(reports);
  const all = rows.sort((a, b) => a.position - b.position).map((r) => overlay(r, byTask.get(r.task_id) || null, false)).sort(compareTasksForBoard);
  return { meta, all };
}

/*──────────────────────────────────────────────────────────────────────────*/

//one report per task for the overlay: the active one when there is one (the task is locked by it), otherwise the newest
//rejected one (the courier may report again after a rejection, the newest is the one the chip should talk about)
function pickReports(reports: LocalReport[]) {
  const byTask = new Map<number, LocalReport>();
  for (const r of reports) {
    const cur = byTask.get(r.task_id);
    if (!cur) {
      byTask.set(r.task_id, r);
      continue;
    }
    const curActive = isActiveState(cur.sync.state);
    const active = isActiveState(r.sync.state);
    if (active !== curActive) {
      if (active) byTask.set(r.task_id, r);
      continue;
    }
    if (r.seq > cur.seq) byTask.set(r.task_id, r);
  }
  return byTask;
}

/*──────────────────────────────────────────────────────────────────────────*/

//returns the board rows for the tab + search, counts for the WHOLE overlaid set (the tab counters are not search results),
//whether the dataset was ever downloaded and when. search matches the same four fields as the server ILIKE. never throws
//on an empty scope dataset, throws on a null scope or an unusable database
export async function readBoard(scope: string, tab: Tab = "all", search = ""): Promise<BoardData> {
  assertScope(scope);
  const { meta, all } = await overlaidRows(scope);
  const pending = all.filter((t) => t.status === TaskStatus.pending).length;
  const counts = { all: all.length, pending, done: all.length - pending };
  const q = (search || "").trim().toLowerCase();
  const rows = all.filter((t) => (tab === "all" || t.status === tab) && (!q || matchesSearch(t, q)));
  return { rows, counts, ready: !!meta?.ready, refreshed_at: meta?.refreshed_at ?? null };
}

/*──────────────────────────────────────────────────────────────────────────*/

function matchesSearch(t: IDeliveryTask, q: string) {
  const i = t.issuance;
  if (!i) return false;
  return [i.sap_number, i.customer_name, i.address_street, i.address_city].some((v) => (v || "").toLowerCase().includes(q));
}

/*──────────────────────────────────────────────────────────────────────────*/

//returns the task as the detail screen should show it: the cached detail body when the task was opened online, else the
//list row, overlaid with the local report. `task` is null when the task is not on this device (nothing more than that:
//a lookup miss offline does not prove the task is someone else's). `detail_available` is false only for a done task whose
//report details never reached the device (no detail row, no active local report), the screen shows
//offline_detail_unavailable for the report block then
export async function readTask(scope: string, id: number): Promise<TaskData> {
  assertScope(scope);
  const db = await openCourierDb();
  const [meta, detail, row, reports] = await Promise.all([
    db.get("meta", scope) as Promise<MetaRow | undefined>,
    db.get("task_details", [scope, id]) as Promise<TaskDetailRow | undefined>,
    db.get("tasks", [scope, id]) as Promise<TaskRow | undefined>,
    db.getAllFromIndex("reports", "by_task", [scope, id]) as Promise<LocalReport[]>,
  ]);
  const report = pickReports(reports).get(id) || null;
  const base = detail || row;
  if (!base) return { task: null, detail_available: false, local_report: report, ready: !!meta?.ready };
  const task = overlay(base, report, !!detail);
  const activeLocal = !!report && isActiveState(report.sync.state);
  const detail_available = base.status !== TaskStatus.done || !!detail || activeLocal;
  return { task, detail_available, local_report: report, ready: !!meta?.ready };
}

/*──────────────────────────────────────────────────────────────────────────*/

//the ids of the open tasks in board order, after the overlay (a task reported on this device is not "next" any more).
//feeds "הנפקה n מתוך N" and the prev / next arrows
export async function readPendingIds(scope: string): Promise<number[]> {
  assertScope(scope);
  const { all } = await overlaidRows(scope);
  return all.filter((t) => t.status === TaskStatus.pending).map((t) => t.id);
}

/*──────────────────────────────────────────────────────────────────────────*/

//the manual איתור הנפקה against the local snapshot. returns the task id or null. null only means "not on this device":
//the caller decides whether to ask the server (online) or show offline_lookup_unavailable
export async function lookupLocal(scope: string, rawNumber: string): Promise<number | null> {
  assertScope(scope);
  const number = normalizeSapNumber(rawNumber);
  if (!number) return null;
  const db = await openCourierDb();
  const rows = (await db.getAllFromIndex("tasks", "by_scope", scope)) as TaskRow[];
  //the newest task wins like the server lookup (order id desc), the list never carries cancelled ones anyway
  const hits = rows.filter((r) => r.issuance?.sap_number === number).sort((a, b) => b.id - a.id);
  return hits.length ? hits[0].id : null;
}

/*──────────────────────────────────────────────────────────────────────────*/

const inFlight = new Map<string, Promise<RefreshResult>>();

//downloads the complete list (tab=all, no search) and replaces the scope's snapshot in one transaction. `fetchAll` is
//injectable for tests, the default goes through the interceptor free instance (a 401 here never logs the courier out).
//a thrown fetch or a response that is not a complete unfiltered list (shape check + rows.length === counts.all) leaves
//the old snapshot in place, writes meta.last_error and resolves { ok: false, error }. concurrent calls for the same scope
//share one promise. never rejects
export async function refresh(scope: string, fetchAll: () => Promise<any> = () => scopedFetchAll(scope)): Promise<RefreshResult> {
  assertScope(scope);
  const running = inFlight.get(scope);
  if (running) return running;
  const p = doRefresh(scope, fetchAll).finally(() => inFlight.delete(scope));
  inFlight.set(scope, p);
  return p;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the default source of a refresh: the list of the account the scope belongs to. refused up front when the stored token
//is someone else's (a second tab still on the first courier after an account switch would otherwise store the second
//courier's list under the first one's scope). same rejection shape as an expired token, the caller sees auth_required
function scopedFetchAll(scope: string): Promise<any> {
  if (!tokenMatchesScope(scope)) {
    noteBackgroundResult("auth");
    return Promise.reject(Object.assign(new Error("auth_required"), { auth_required: true }));
  }
  return offlineGet("/delivery/tasks", { tab: "all" });
}

/*──────────────────────────────────────────────────────────────────────────*/

async function doRefresh(scope: string, fetchAll: () => Promise<any>): Promise<RefreshResult> {
  let res: any;
  try {
    res = await fetchAll();
  } catch (e) {
    const error = errorText(e);
    await writeLastError(scope, error).catch(() => {});
    return { ok: false, error };
  }
  const problem = snapshotProblem(res);
  if (problem) {
    await writeLastError(scope, problem).catch(() => {});
    return { ok: false, error: problem };
  }

  const rows: IDeliveryTask[] = res.rows;
  const ids = new Set(rows.map((r) => r.id));
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  try {
    await writeTx(["tasks", "meta", "task_details", "reports"], async (tx) => {
      const tasks = tx.objectStore("tasks");
      await tasks.delete(scopeRange(scope));
      for (let i = 0; i < rows.length; i++) await tasks.put({ ...rows[i], scope, task_id: rows[i].id, position: i });

      const metaStore = tx.objectStore("meta");
      const meta: MetaRow = (await metaStore.get(scope)) || metaFromScope(scope);
      await metaStore.put({ ...meta, refreshed_at: now, ready: true, last_error: null });

      //details of tasks that left the list (cancelled, reassigned, deleted) are dead weight
      const details = tx.objectStore("task_details");
      for (const key of await details.getAllKeys(scopeRange(scope))) if (!ids.has(key[1])) await details.delete(key);

      //only synced reports are pruned, and only when their task is gone or the ack is older than the retention. every
      //other state stays on the device until someone looks at it: there is no dismiss action, review is manual
      const reports = tx.objectStore("reports");
      for (const r of (await reports.index("by_scope").getAll(scope)) as LocalReport[]) {
        if (r.sync.state !== ReportSyncState.synced) continue;
        const ackAt = Date.parse(r.ack?.reported_at || r.sync.updated_at);
        if (!ids.has(r.task_id) || ackAt < nowMs - REPORT_RETENTION_MS) await reports.delete([scope, r.operation_id]);
      }
    });
  } catch (e) {
    const error = storageError(e);
    await writeLastError(scope, error).catch(() => {});
    return { ok: false, error };
  }

  noteBackgroundResult("ok");
  emit("tasks", scope);
  return { ok: true };
}

/*──────────────────────────────────────────────────────────────────────────*/

//the cheap proof that the list is complete: the counters are computed on the server over the whole courier collection,
//so a filtered or truncated response cannot match them
function snapshotProblem(res: any): string | null {
  if (!res || !Array.isArray(res.rows)) return "invalid snapshot: rows";
  if (!res.counts || typeof res.counts.all !== "number") return "invalid snapshot: counts";
  for (const r of res.rows) {
    if (typeof r?.id !== "number" || typeof r?.issuance?.id !== "number" || typeof r?.issuance?.sap_number !== "string") return `invalid snapshot: row ${r?.id}`;
  }
  if (res.rows.length !== res.counts.all) return `invalid snapshot: ${res.rows.length} rows for counts.all ${res.counts.all}`;
  return null;
}

/*──────────────────────────────────────────────────────────────────────────*/

function errorText(e: any) {
  if (e?.auth_required) return "auth_required";
  const m = e?.response?.data?.message;
  return (Array.isArray(m) ? m.join(", ") : m) || e?.message || String(e);
}

/*──────────────────────────────────────────────────────────────────────────*/

async function writeLastError(scope: string, error: string) {
  await writeTx(["meta"], async (tx) => {
    const meta: MetaRow = (await tx.objectStore("meta").get(scope)) || metaFromScope(scope);
    await tx.objectStore("meta").put({ ...meta, last_error: error });
  });
  emit("meta", scope);
}

/*──────────────────────────────────────────────────────────────────────────*/

//refresh only when the last successful one is older than maxAgeMs (the throttle behind the focus / online triggers).
//resolves { ok: true, skipped: true } inside the window
export async function refreshIfStale(scope: string, maxAgeMs: number): Promise<RefreshResult> {
  assertScope(scope);
  const db = await openCourierDb();
  const meta = (await db.get("meta", scope)) as MetaRow | undefined;
  if (meta?.refreshed_at && Date.now() - Date.parse(meta.refreshed_at) < maxAgeMs) return { ok: true, skipped: true };
  return refresh(scope);
}

/*──────────────────────────────────────────────────────────────────────────*/

//stores the body of GET /delivery/tasks/:id so a done task's report (items + signature) opens offline later. throws a
//storage error (storageError) when the write fails
export async function cacheTaskDetail(scope: string, task: IDeliveryTask): Promise<void> {
  assertScope(scope);
  await writeTx(["task_details"], async (tx) => {
    await tx.objectStore("task_details").put({ ...task, scope, task_id: task.id });
  });
  emit("tasks", scope);
}

/*──────────────────────────────────────────────────────────────────────────*/

//the saved draft of a task or null
export async function getDraft(scope: string, taskId: number): Promise<DraftRow | null> {
  assertScope(scope);
  const db = await openCourierDb();
  return ((await db.get("drafts", [scope, taskId])) as DraftRow) || null;
}

/*──────────────────────────────────────────────────────────────────────────*/

//writes the draft, resolved after the commit. returns { blocked: true } and writes nothing when the task already has a
//report in an active state: a debounced autosave that fires after the courier tapped send must not resurrect the draft.
//throws a storage error (map it with storageError) when the write fails
export async function putDraft(scope: string, taskId: number, draft: DraftInput): Promise<{ blocked: boolean }> {
  assertScope(scope);
  const result = await writeTx(["drafts", "reports"], async (tx, abort) => {
    const reports = (await tx.objectStore("reports").index("by_task").getAll([scope, taskId])) as LocalReport[];
    if (reports.some((r) => isActiveState(r.sync.state))) {
      abort();
      return { blocked: true };
    }
    await tx.objectStore("drafts").put({ ...draft, scope, task_id: taskId, updated_at: new Date().toISOString() });
    return { blocked: false };
  });
  if (!result.blocked) emit("drafts", scope);
  return result;
}

/*──────────────────────────────────────────────────────────────────────────*/

export async function deleteDraft(scope: string, taskId: number): Promise<void> {
  assertScope(scope);
  await writeTx(["drafts"], async (tx) => {
    await tx.objectStore("drafts").delete([scope, taskId]);
  });
  emit("drafts", scope);
}

/*──────────────────────────────────────────────────────────────────────────*/

//nothing handed over: every line of the issuance answered "not delivered". no one received and no one signs, so the
//recipient and the signature are neither asked for nor sent (the same rule as handedOver() on the server, read from the
//form instead of validated answers). a line still unanswered keeps both sections on the screen, the item errors block
//the send anyway
export function nothingDelivered(task: IDeliveryTask, answers: Record<number, any>): boolean {
  const items = task?.issuance?.items || [];
  return items.length > 0 && items.every((i) => answers?.[i.id]?.delivered === false);
}

/*──────────────────────────────────────────────────────────────────────────*/

//the same checks as the old TaskDetailPage.validate, returning the field error map with i18n KEYS as values (the screen
//runs t() on them): { item_<id>: { delivered, reason, reason_details }, recipient_name, recipient_id_number,
//recipient_phone, signature }. an empty object means the form is complete
export function validateReportForm(task: IDeliveryTask, form: ReportForm): Record<string, any> {
  const errors: Record<string, any> = {};
  for (const item of task.issuance?.items || []) {
    const a = form.answers?.[item.id] || {};
    const itemErrors: any = {};
    if (a.delivered === undefined) itemErrors.delivered = "required";
    if (a.delivered === false && !a.reason) itemErrors.reason = "required";
    if (a.delivered === false && !(a.reason_details || "").trim()) itemErrors.reason_details = "required";
    if (Object.keys(itemErrors).length) errors[`item_${item.id}`] = itemErrors;
  }
  if (nothingDelivered(task, form.answers)) return errors;
  if (form.recipient_type === RecipientType.other) {
    if (!(form.recipient?.name || "").trim()) errors.recipient_name = "required";
    if (!(form.recipient?.id_number || "").trim()) errors.recipient_id_number = "required";
    if (!(form.recipient?.phone || "").trim()) errors.recipient_phone = "required";
  }
  if (!form.signature_png) errors.signature = "signature_missing";
  return errors;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the same derivation as attempt.validation.outcomeOf on the server, for the local display only (the server never reads it)
export function outcomeOf(items: { delivered?: boolean }[]): AttemptOutcome {
  const delivered = items.filter((a) => a.delivered).length;
  if (delivered === items.length) return AttemptOutcome.delivered;
  if (delivered === 0) return AttemptOutcome.not_delivered;
  return AttemptOutcome.partially_delivered;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the local first send, online and offline alike: validate, build the payload the way the old submit did, freeze it as a
//report with a fresh operation id, and in ONE transaction write the report and delete the draft. resolves with the report
//only after the commit, then kicks the worker. rejects with:
//  { fields }             the validation map of validateReportForm (nothing written)
//  { blocked: "locked" }  the task already has a report in queued / syncing / synced / auth (nothing written)
//  { storage: key }       the write failed, key is storage_quota / storage_unavailable / local_save_failed (nothing written)
export async function submitReport(scope: string, user: IAuthUser, task: IDeliveryTask, form: ReportForm): Promise<LocalReport> {
  assertScope(scope);
  const fields = validateReportForm(task, form);
  if (Object.keys(fields).length) throw { fields };

  const issuance = task.issuance;
  const items = issuance.items.map((item) => ({ item_id: item.id, ...form.answers[item.id] }));
  const other = form.recipient_type === RecipientType.other;
  const handover = !nothingDelivered(task, form.answers);
  const now = Date.now();
  //two sends inside the same millisecond (prev / next on a fast tablet) must still go out in order
  lastSeq = Math.max(now, lastSeq + 1);
  const report: LocalReport = {
    operation_id: newOperationId(),
    scope,
    user_id: user.id,
    courier_id: user.courier_id,
    task_id: task.id,
    issuance_id: issuance.id,
    issuance_revision: issuance.revision ?? null,
    seq: lastSeq,
    display: {
      sap_number: issuance.sap_number,
      number_prefix: issuance.number_prefix,
      customer_name: issuance.customer_name,
      customer_phone: issuance.customer_phone,
      address_street: issuance.address_street,
      address_building: issuance.address_building,
      address_city: issuance.address_city,
      items: issuance.items.map((i) => ({ id: i.id, product_name: i.product_name, catalog_number: i.catalog_number, quantity: i.quantity })),
      //mirrors validateRecipient on the server: "הלקוח/ה" means the customer of the issuance, whatever the fields hold.
      //null when nothing was delivered: no one received
      recipient: !handover
        ? null
        : other
          ? { name: form.recipient.name, id_number: form.recipient.id_number, phone: form.recipient.phone }
          : { name: issuance.customer_name, id_number: issuance.customer_id_number || "", phone: issuance.customer_phone || "" },
    },
    payload: handover
      ? {
          recipient_type: form.recipient_type,
          recipient_name: form.recipient.name,
          recipient_id_number: form.recipient.id_number,
          recipient_phone: form.recipient.phone,
          signature_png: form.signature_png,
          items,
        }
      //nothing handed over: no recipient and no signature leave the device, whatever the form still held from before the
      //courier switched the last line to "not delivered"
      : { recipient_type: null, signature_png: null, items },
    outcome: outcomeOf(items),
    client_reported_at: new Date(now).toISOString(),
    sync: { state: ReportSyncState.queued, tries: 0, next_at: null, last_error: null, http_status: null, conflict_code: null, updated_at: new Date(now).toISOString() },
    ack: null,
  };

  try {
    //meta rides along so the name shown next to "reports of another account" comes from the same commit as the report
    await writeTx(["reports", "drafts", "meta"], async (tx, abort) => {
      const reports = tx.objectStore("reports");
      const existing = (await reports.index("by_task").getAll([scope, task.id])) as LocalReport[];
      if (existing.some((r) => isActiveState(r.sync.state))) {
        abort();
        throw { blocked: "locked" };
      }
      await reports.put(report);
      await tx.objectStore("drafts").delete([scope, task.id]);
      const metaStore = tx.objectStore("meta");
      const meta: MetaRow = (await metaStore.get(scope)) || metaFromScope(scope);
      await metaStore.put({ ...meta, username: user.username || meta.username, display_name: user.name || meta.display_name });
    });
  } catch (e) {
    if (e?.blocked) throw e;
    throw { storage: storageError(e) };
  }

  emit("reports", scope);
  kickSync("enqueue").catch(() => {});
  return report;
}

/*──────────────────────────────────────────────────────────────────────────*/

//every report of the scope in enqueue order (seq asc), all states
export async function listReports(scope: string): Promise<LocalReport[]> {
  assertScope(scope);
  const db = await openCourierDb();
  const rows = (await db.getAllFromIndex("reports", "by_scope", scope)) as LocalReport[];
  return rows.sort((a, b) => a.seq - b.seq);
}

/*──────────────────────────────────────────────────────────────────────────*/

export async function getReport(scope: string, operationId: string): Promise<LocalReport | null> {
  assertScope(scope);
  const db = await openCourierDb();
  return ((await db.get("reports", [scope, operationId])) as LocalReport) || null;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the worker's write: merges `patch` into report.sync (updated_at is set here) and stores `ack` when given. business
//content is never touched. resolves with the updated report, or null when the row is gone
export async function updateReportSync(scope: string, operationId: string, patch: Partial<ReportSync>, ack?: IAttemptResult): Promise<LocalReport | null> {
  assertScope(scope);
  const updated = await writeTx(["reports"], async (tx) => {
    const store = tx.objectStore("reports");
    const r = (await store.get([scope, operationId])) as LocalReport | undefined;
    if (!r) return null;
    const next: LocalReport = { ...r, sync: { ...r.sync, ...patch, updated_at: new Date().toISOString() }, ack: ack === undefined ? r.ack : ack };
    await store.put(next);
    return next;
  });
  emit("reports", scope);
  return updated;
}

/*──────────────────────────────────────────────────────────────────────────*/

//manual retry of one report: only from queued / auth (a permanent state is not retried), back to queued with the backoff
//and the tries cleared. resolves false when the state did not allow it
export async function retryReport(scope: string, operationId: string): Promise<boolean> {
  const r = await getReport(scope, operationId);
  if (!r || (r.sync.state !== ReportSyncState.queued && r.sync.state !== ReportSyncState.auth)) return false;
  await updateReportSync(scope, operationId, { state: ReportSyncState.queued, next_at: null, tries: 0 });
  return true;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the "סנכרון עכשיו" button: every queued / auth report of the scope back to queued, due now
export async function retryAll(scope: string): Promise<number> {
  let n = 0;
  for (const r of await listReports(scope)) {
    if (r.sync.state !== ReportSyncState.queued && r.sync.state !== ReportSyncState.auth) continue;
    await updateReportSync(scope, r.operation_id, { state: ReportSyncState.queued, next_at: null, tries: 0 });
    n++;
  }
  return n;
}

/*──────────────────────────────────────────────────────────────────────────*/

//after a fresh login: auth -> queued, but only for rows written by the same user id. another account's rows stay parked
export async function requeueAuth(scope: string, userId: number): Promise<number> {
  let n = 0;
  for (const r of await listReports(scope)) {
    if (r.sync.state !== ReportSyncState.auth || r.user_id !== userId) continue;
    await updateReportSync(scope, r.operation_id, { state: ReportSyncState.queued, next_at: null });
    n++;
  }
  return n;
}

/*──────────────────────────────────────────────────────────────────────────*/

//a 401 (or a missing / foreign / expired token): every queued / syncing report of the scope waits for a login
export async function markReportsAuth(scope: string): Promise<number> {
  let n = 0;
  for (const r of await listReports(scope)) {
    if (r.sync.state !== ReportSyncState.queued && r.sync.state !== ReportSyncState.syncing) continue;
    await updateReportSync(scope, r.operation_id, { state: ReportSyncState.auth, next_at: null, http_status: 401 });
    n++;
  }
  return n;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the worker's write on the evidence axis: merges `patch` into report.evidence. business content and `sync` are never
//touched here. a `receipt` (kind conflict_recorded) fills the server ids. resolves with the updated report or null
export async function updateReportEvidence(scope: string, operationId: string, patch: Partial<ReportEvidence>, receipt?: IConflictReceipt): Promise<LocalReport | null> {
  assertScope(scope);
  const updated = await writeTx(["reports"], async (tx) => {
    const store = tx.objectStore("reports");
    const r = (await store.get([scope, operationId])) as LocalReport | undefined;
    if (!r) return null;
    const base = evidenceOf(r);
    const fromReceipt: Partial<ReportEvidence> = receipt ? { conflict_id: receipt.conflict_id, received_at: receipt.received_at, reviewed_at: receipt.reviewed_at || null } : {};
    const next: LocalReport = { ...r, evidence: { ...base, ...fromReceipt, ...patch, updated_at: new Date().toISOString() } };
    await store.put(next);
    return next;
  });
  emit("reports", scope);
  return updated;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the courier's "שליחה חוזרת לבדיקה": a failed or waiting evidence upload goes out again on the next pass. the delivery
//report itself is not retried, its state stays `conflict`
export async function retryEvidence(scope: string, operationId: string): Promise<boolean> {
  const r = await getReport(scope, operationId);
  if (!r || r.sync.state !== ReportSyncState.conflict) return false;
  const e = evidenceOf(r);
  if (e.state === EvidenceUploadState.received || e.state === EvidenceUploadState.reviewed || e.state === EvidenceUploadState.uploading) return false;
  await updateReportEvidence(scope, operationId, { state: EvidenceUploadState.pending, next_at: null, tries: 0 });
  return true;
}

/*──────────────────────────────────────────────────────────────────────────*/

//a reconnect (online / focus / manual) drops the backoff of rows whose last failure was a network error, so they go out
//right away. rows the server answered keep their schedule. the evidence axis follows the same rule
export async function clearNetworkBackoff(scope: string): Promise<number> {
  let n = 0;
  for (const r of await listReports(scope)) {
    const e = evidenceOf(r);
    if (r.sync.state === ReportSyncState.conflict && e.state === EvidenceUploadState.pending && e.next_at && e.http_status === null) {
      await updateReportEvidence(scope, r.operation_id, { next_at: null });
      n++;
    }
    if (r.sync.state !== ReportSyncState.queued || !r.sync.next_at || r.sync.http_status !== null) continue;
    await updateReportSync(scope, r.operation_id, { next_at: null });
    n++;
  }
  return n;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the one cross scope reader: every account on this device with reports in queued / syncing / auth, minus `except`.
//the status bar passes the current scope, the login page passes nothing. names come from the meta row
export async function otherScopesWithPendingWork(except?: string): Promise<ScopeWork[]> {
  const db = await openCourierDb();
  const metas = (await db.getAll("meta")) as MetaRow[];
  const out: ScopeWork[] = [];
  for (const m of metas) {
    if (m.scope === except) continue;
    const reports = (await db.getAllFromIndex("reports", "by_scope", m.scope)) as LocalReport[];
    const count = reports.filter((r) => PENDING_STATES.includes(r.sync.state)).length;
    if (count) out.push({ scope: m.scope, username: m.username, display_name: m.display_name, count });
  }
  return out;
}

/*──────────────────────────────────────────────────────────────────────────*/

export type ClearResult = { reports: number; drafts: number };

//what a logout and a start under another account remove: the server's copies of the scope (the snapshot, the cached
//details, the reports the server acknowledged). a report in any other state and a draft are the only copy there is and
//stay; the meta row stays with them to name their owner for the login notice, its snapshot fields back to "never
//downloaded" since the rows it described are gone, and is deleted once nothing is left. one transaction, never clear()
//(other scopes live in the same stores). a refresh still in flight for the scope (the one a sync pass starts after it
//delivered) is waited for first, or its snapshot would land after the delete. nothing is emitted: the screens of the
//scope are leaving and the other tabs with it. resolves with what stayed
export async function clearSyncedData(scope: string): Promise<ClearResult> {
  assertScope(scope);
  await inFlight.get(scope)?.catch(() => {});
  return writeTx(["tasks", "task_details", "reports", "drafts", "meta"], async (tx) => {
    await tx.objectStore("tasks").delete(scopeRange(scope));
    await tx.objectStore("task_details").delete(scopeRange(scope));
    const reports = tx.objectStore("reports");
    let keptReports = 0;
    for (const r of (await reports.index("by_scope").getAll(scope)) as LocalReport[]) {
      if (r.sync.state === ReportSyncState.synced) await reports.delete([scope, r.operation_id]);
      else keptReports++;
    }
    const drafts = (await tx.objectStore("drafts").getAllKeys(scopeRange(scope))).length;
    const metaStore = tx.objectStore("meta");
    if (!keptReports && !drafts) await metaStore.delete(scope);
    else {
      const meta: MetaRow | undefined = await metaStore.get(scope);
      if (meta) await metaStore.put({ ...meta, refreshed_at: null, ready: false, last_error: null, sync_lease: null });
    }
    return { reports: keptReports, drafts };
  });
}

/*──────────────────────────────────────────────────────────────────────────*/

//the two numbers the strip and the logout decide by, read from the database: reports still to send (queued / syncing /
//auth) and the ones someone has to look at. the worker's status carries the same pair but only refreshes it at the end
//of a pass, so a decision taken while a pass runs reads the database instead
export async function countReports(scope: string): Promise<{ pending: number; attention: number }> {
  const rows = await listReports(scope);
  return { pending: rows.filter((r) => PENDING_STATES.includes(r.sync.state)).length, attention: rows.filter(needsAttention).length };
}

/*──────────────────────────────────────────────────────────────────────────*/

//every account on this device but `current` loses its server copies, so a courier never inherits another one's cache
//(signatures, recipient id numbers). meta driven: a scope with anything to remove wrote its meta row on the refresh or
//the submit that stored it
export async function clearForeignScopes(current: string): Promise<void> {
  assertScope(current);
  const db = await openCourierDb();
  const metas = (await db.getAll("meta")) as MetaRow[];
  for (const m of metas) if (m.scope !== current) await clearSyncedData(m.scope);
}

/*──────────────────────────────────────────────────────────────────────────*/

//the cross tab lock for browsers without web locks (plain http on a lan). one lease per scope in meta: taken when free,
//expired or already ours. resolves true when this owner holds it now
export async function takeSyncLease(scope: string, owner: string, ttlMs: number, now: number): Promise<boolean> {
  assertScope(scope);
  return writeTx(["meta"], async (tx) => {
    const store = tx.objectStore("meta");
    const meta: MetaRow = (await store.get(scope)) || metaFromScope(scope);
    const lease = meta.sync_lease;
    if (lease && lease.owner !== owner && lease.until > now) return false;
    await store.put({ ...meta, sync_lease: { owner, until: now + ttlMs } });
    return true;
  });
}

/*──────────────────────────────────────────────────────────────────────────*/

export async function releaseSyncLease(scope: string, owner: string): Promise<void> {
  assertScope(scope);
  await writeTx(["meta"], async (tx) => {
    const store = tx.objectStore("meta");
    const meta: MetaRow | undefined = await store.get(scope);
    if (!meta?.sync_lease || meta.sync_lease.owner !== owner) return;
    await store.put({ ...meta, sync_lease: null });
  });
}

/*──────────────────────────────────────────────────────────────────────────*/

//the shown task = snapshot task + local report. a pending snapshot task with an active report becomes done on screen with
//the local attempt; a rejected report only attaches local_report so the card shows the attention chip; a done snapshot
//task (the server has the real attempt after a refresh) keeps local_report for every state, and shows the local attempt
//when there is no detail row (the list row's attempt has no items and no signature). the snapshot object is not mutated
export function overlay(task: IDeliveryTask, report: LocalReport | null, hasDetail: boolean): IDeliveryTask {
  if (!report) return task;
  const ref = { operation_id: report.operation_id, state: report.sync.state, conflict_code: report.sync.conflict_code || undefined, client_reported_at: report.client_reported_at };
  const active = isActiveState(report.sync.state);

  if (task.status === TaskStatus.pending) {
    if (!active) return { ...task, local_report: ref };
    return {
      ...task,
      status: TaskStatus.done,
      closed_at: report.client_reported_at,
      issuance: { ...task.issuance, status: report.outcome as any },
      attempts: [localAttempt(report)],
      local_report: ref,
    };
  }

  if (task.status === TaskStatus.done && active && !hasDetail) return { ...task, attempts: [localAttempt(report)], local_report: ref };
  return { ...task, local_report: ref };
}

/*──────────────────────────────────────────────────────────────────────────*/

//the attempt row the read only report block renders from a local report. the ack fills the server ids when it exists
export function localAttempt(report: LocalReport): IDeliveryAttempt {
  return {
    id: report.ack?.attempt_id ?? 0,
    task_id: report.task_id,
    outcome: report.outcome,
    recipient_type: report.payload.recipient_type,
    recipient_name: report.display.recipient?.name ?? null,
    recipient_id_number: report.display.recipient?.id_number ?? null,
    recipient_phone: report.display.recipient?.phone ?? null,
    signature_png: report.payload.signature_png,
    reported_at: report.ack?.reported_at ?? report.client_reported_at,
    client_reported_at: report.client_reported_at,
    items: report.payload.items,
  };
}

/*──────────────────────────────────────────────────────────────────────────*/

//a small event bus: the hooks re-read on every event of their scope, the worker listens for "kick". a BroadcastChannel
//carries the same events to the other tabs, created lazily (jsdom and old webviews have none) and unref'ed where the
//method exists (a no-op in browsers, keeps vitest's forked worker from hanging on node's channel)
const listeners = new Set<(e: StoreEvent) => void>();
let bc: BroadcastChannel | null = null;

function channel(): BroadcastChannel | null {
  if (bc) return bc;
  if (typeof BroadcastChannel === "undefined") return null;
  bc = new BroadcastChannel("es-courier");
  (bc as any).unref?.();
  bc.addEventListener("message", (e: MessageEvent) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "change") notify({ kind: m.kind || "tasks", scope: m.scope, remote: true });
    if (m.type === "kick") notify({ kind: "kick", scope: m.scope });
  });
  return bc;
}

/*──────────────────────────────────────────────────────────────────────────*/

function notify(e: StoreEvent) {
  for (const fn of Array.from(listeners)) {
    try {
      fn(e);
    } catch (err) {
      // console.log("store listener failed", err);
    }
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//subscribe to local and cross tab events. returns the unsubscribe function
export function subscribe(fn: (e: StoreEvent) => void): () => void {
  listeners.add(fn);
  channel();
  return () => {
    listeners.delete(fn);
  };
}

/*──────────────────────────────────────────────────────────────────────────*/

//a data change of `scope`: local listeners first, then the other tabs
export function emit(kind: StoreEvent["kind"], scope: string) {
  notify({ kind, scope });
  try {
    channel()?.postMessage({ type: "change", kind, scope });
  } catch (e) {
    //a closed channel, nothing to tell
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//a tab that could not take the sync lock asks the holder to run a pass
export function postKick(scope: string) {
  try {
    channel()?.postMessage({ type: "kick", scope });
  } catch (e) {
    //same
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//closes the BroadcastChannel (stopSync and the test teardown). a later emit / subscribe opens a new one
export function closeChannel() {
  if (!bc) return;
  try {
    bc.close();
  } catch (e) {
    //already closed
  }
  bc = null;
}
