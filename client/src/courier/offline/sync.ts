import axios from "axios";

import { AttemptOutcome, IAttemptResult, ReportConflictCode, ReportSyncState } from "../../../../shared/@core";
import { currentToken, decodeJwt, tokenIsFresh } from "./identity";
import { LocalReport } from "./db";
import { clearNetworkBackoff, closeChannel, listReports, markReportsAuth, postKick, releaseSyncLease, requeueAuth, subscribe, takeSyncLease, updateReportSync, emit } from "./store";

//the one worker that sends queued reports. module level, one scope at a time: startSync(scope) after login, stopSync()
//on logout. a pass takes the cross tab lock, sends every due report by seq, releases the lock. nothing runs while the
//app is closed (no background sync), and nothing is promised for that

export type SyncStatus = {
  scope: string | null;
  online: boolean; //navigator.onLine, a hint only
  reachable: boolean | null; //what the last request said, the proof
  running: boolean;
  auth_required: boolean;
  pending: number; //queued + syncing + auth
  attention: number; //invalid + forbidden + conflict
  last_sync_at: string | null;
  last_error: string | null;
};

export type Transport = { post: (url: string, body: any, token: string, timeoutMs: number) => Promise<{ status: number; data: any }> };
export type SyncDeps = { transport?: Transport; now?: () => number; random?: () => number; afterSynced?: (scope: string) => void };
export type KickReason = "enqueue" | "retry" | "online" | "visible" | "focus" | "channel" | "timer" | "start";

const REQUEST_TIMEOUT_MS = 20_000;
const TIMER_MS = 60_000;
const LEASE_MS = 45_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const RETRYABLE = [408, 425, 429];
const RECONNECT_REASONS: KickReason[] = ["retry", "online", "visible", "focus"];

//the worker's own axios instance: no response interceptor, so a 401 here never clears the session or navigates. the data
//layer's background reads share it (offlineGet)
const bg = axios.create({ baseURL: "/api", timeout: REQUEST_TIMEOUT_MS });

const defaultTransport: Transport = {
  async post(url, body, token, timeoutMs) {
    const r = await bg.post(url, body, { timeout: timeoutMs, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
    return { status: r.status, data: r.data };
  },
};

function initialStatus(scope: string | null): SyncStatus {
  return { scope, online: typeof navigator === "undefined" ? true : navigator.onLine !== false, reachable: null, running: false, auth_required: false, pending: 0, attention: 0, last_sync_at: null, last_error: null };
}

//one id per tab for the lease fallback
const tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);

let generation = 0;
let scope: string | null = null;
let deps: Required<Pick<SyncDeps, "transport" | "now" | "random">> & Pick<SyncDeps, "afterSynced"> = { transport: defaultTransport, now: Date.now, random: Math.random };
let status: SyncStatus = initialStatus(null);
let running = false;
let dirty = false;
let passPromise: Promise<void> | null = null;
//the token (or null) that last parked the queue in auth. a trigger under the same token does not requeue, otherwise a
//token the server rejects would be resent on every focus; a new login is a new string and goes through
let authFailedToken: string | null | undefined = undefined;
let timer: any = null;
let unsubscribeStore: (() => void) | null = null;
let windowListeners: { target: any; type: string; fn: any }[] = [];
const statusListeners = new Set<(s: SyncStatus) => void>();

/*──────────────────────────────────────────────────────────────────────────*/

//a background GET through the interceptor free instance. skipped up front when the stored token is missing or expired
//(rejects with { auth_required: true }); a 401 answer marks auth_required in the status, a network failure marks the
//server unreachable. rejects with the axios error otherwise, resolves with the body
export async function offlineGet(path: string, params?: any): Promise<any> {
  const token = currentToken();
  if (!tokenIsFresh(token)) {
    noteBackgroundResult("auth");
    throw Object.assign(new Error("auth_required"), { auth_required: true });
  }
  try {
    const r = await bg.get(path, { params, headers: { Authorization: `Bearer ${token}` } });
    noteBackgroundResult("ok");
    return r.data;
  } catch (e: any) {
    if (e?.response?.status === 401) noteBackgroundResult("auth");
    else if (!e?.response) noteBackgroundResult("network");
    else noteBackgroundResult("ok");
    throw e;
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//what a background request learned about the server, from this module or the data layer
export function noteBackgroundResult(kind: "ok" | "network" | "auth") {
  if (kind === "ok") setStatus({ reachable: true, last_error: null });
  if (kind === "network") setStatus({ reachable: false });
  if (kind === "auth") setStatus({ reachable: true, auth_required: true });
}

/*──────────────────────────────────────────────────────────────────────────*/

//a copy of the current status
export function getSyncStatus(): SyncStatus {
  return { ...status };
}

/*──────────────────────────────────────────────────────────────────────────*/

//called with the new status after every change. returns the unsubscribe function
export function subscribeSync(fn: (s: SyncStatus) => void): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

/*──────────────────────────────────────────────────────────────────────────*/

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  for (const fn of Array.from(statusListeners)) {
    try {
      fn(status);
    } catch (e) {
      // console.log("sync listener failed", e);
    }
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//starts the worker for `scope` (a previous scope is stopped first): recovers rows left in syncing by a killed run,
//requeues auth rows when the stored token belongs to the scope's user, wires the triggers and runs the first pass.
//resolves when that first pass is over. `deps` are for tests (transport / now / random) and for the app's afterSynced,
//called once per pass that synced at least one report (CourierLayout wires refresh there). throws on an empty scope
export async function startSync(s: string, d: SyncDeps = {}): Promise<void> {
  if (!s) throw new Error("startSync needs a scope");
  teardown();
  generation++;
  const gen = generation;
  scope = s;
  deps = { transport: d.transport || defaultTransport, now: d.now || Date.now, random: d.random || Math.random, afterSynced: d.afterSynced };
  running = false;
  dirty = false;
  status = initialStatus(s);
  setStatus({});

  unsubscribeStore = subscribe((e) => {
    if (e.kind === "kick" && e.scope === scope) kickSync("channel").catch(() => {});
  });
  if (typeof window !== "undefined") {
    listen(window, "online", () => {
      setStatus({ online: true });
      kickSync("online").catch(() => {});
    });
    listen(window, "offline", () => setStatus({ online: false }));
    listen(window, "focus", () => kickSync("focus").catch(() => {}));
  }
  if (typeof document !== "undefined") {
    listen(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") kickSync("visible").catch(() => {});
    });
  }

  //a row left in syncing belongs to a run that died mid request. the server is idempotent, resend the same operation id
  for (const r of await listReports(s)) {
    if (gen !== generation) return;
    if (r.sync.state === ReportSyncState.syncing) await updateReportSync(s, r.operation_id, { state: ReportSyncState.queued });
  }
  if (gen !== generation) return;
  await requeueIfSameAccount(s);
  if (gen !== generation) return;
  await refreshCounts(s);
  if (gen !== generation) return;
  await runPass();
}

/*──────────────────────────────────────────────────────────────────────────*/

//stops everything: timers, window listeners, the store subscription and the channel. an in flight request finishes on
//its own but its result is dropped (generation), so nothing of the old account lands in a new one
export function stopSync() {
  teardown();
  generation++;
  scope = null;
  running = false;
  dirty = false;
  passPromise = null;
  setStatus({ scope: null, running: false });
}

/*──────────────────────────────────────────────────────────────────────────*/

function teardown() {
  if (timer) clearTimeout(timer);
  timer = null;
  for (const l of windowListeners) l.target.removeEventListener(l.type, l.fn);
  windowListeners = [];
  unsubscribeStore?.();
  unsubscribeStore = null;
  closeChannel();
}

/*──────────────────────────────────────────────────────────────────────────*/

function listen(target: any, type: string, fn: any) {
  target.addEventListener(type, fn);
  windowListeners.push({ target, type, fn });
}

/*──────────────────────────────────────────────────────────────────────────*/

//tests: like stopSync, plus the status and its listeners go back to zero
export function resetSyncForTests() {
  stopSync();
  statusListeners.clear();
  status = initialStatus(null);
  authFailedToken = undefined;
}

/*──────────────────────────────────────────────────────────────────────────*/

//asks for a pass. reconnect reasons (retry / online / visible / focus) first drop the backoff of network failures so
//the queue goes out right away; every reason requeues auth rows when the stored token belongs to the scope's user. when a
//pass is already running the request is folded into it (dirty loop) instead of waiting for the timer. resolves when the
//pass that covers the request is over; resolves at once when no worker is running
export async function kickSync(reason: KickReason): Promise<void> {
  if (!scope) return;
  const s = scope;
  const gen = generation;
  try {
    if (RECONNECT_REASONS.includes(reason)) await clearNetworkBackoff(s);
    if (gen !== generation) return;
    await requeueIfSameAccount(s);
  } catch (e) {
    //a failed prep write is not a reason to skip the pass
  }
  if (gen !== generation) return;
  if (running) {
    dirty = true;
    return passPromise || undefined;
  }
  return runPass();
}

/*──────────────────────────────────────────────────────────────────────────*/

//auth rows go back to queued only under a fresh token of the same user id. another account's token leaves them parked
async function requeueIfSameAccount(s: string) {
  const token = currentToken();
  const jwt = decodeJwt(token);
  if (!jwt || !tokenIsFresh(token, deps.now()) || token === authFailedToken) return;
  const userId = Number(s.split(":")[0]);
  if (jwt.sub !== userId) return;
  const n = await requeueAuth(s, userId);
  if (n) setStatus({ auth_required: false });
}

/*──────────────────────────────────────────────────────────────────────────*/

//parks every queued / syncing row of the scope and remembers which token did it
async function parkForAuth(s: string, token: string | null, error: string | null) {
  authFailedToken = token;
  await markReportsAuth(s);
  setStatus({ auth_required: true, last_error: error });
}

/*──────────────────────────────────────────────────────────────────────────*/

function runPass(): Promise<void> {
  if (!scope || running) return passPromise || Promise.resolve();
  running = true;
  const gen = generation;
  const s = scope;
  setStatus({ running: true });
  const p = (async () => {
    const synced = { count: 0 };
    try {
      await withLock(s, async (acquired) => {
        if (!acquired) {
          //another tab holds the lock: let it send our new row in its own dirty loop
          postKick(s);
          return;
        }
        do {
          dirty = false;
          const stop = await processDue(gen, s, synced);
          if (stop || gen !== generation) break;
        } while (dirty);
      });
    } catch (e) {
      if (gen === generation) setStatus({ last_error: e?.message || String(e) });
    }
    if (gen !== generation) return;
    if (synced.count) {
      setStatus({ last_sync_at: new Date(deps.now()).toISOString() });
      emit("reports", s);
      try {
        deps.afterSynced?.(s);
      } catch (e) {
        // console.log("afterSynced failed", e);
      }
    }
    await refreshCounts(s);
  })().finally(() => {
    if (gen !== generation) return;
    running = false;
    passPromise = null;
    setStatus({ running: false });
    scheduleTimer();
  });
  passPromise = p;
  return p;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the lock is taken per pass, never for the worker's lifetime: a background tab holding it forever would be frozen by
//the browser and the foreground tab would never sync. web locks with ifAvailable when they exist, else the meta lease
async function withLock(s: string, fn: (acquired: boolean) => Promise<void>) {
  const locks = webLocks();
  if (locks) {
    await locks.request("es-courier-sync:" + s, { ifAvailable: true }, (lock: any) => fn(!!lock));
    return;
  }
  const got = await takeSyncLease(s, tabId, LEASE_MS, deps.now());
  try {
    await fn(got);
  } finally {
    if (got) await releaseSyncLease(s, tabId).catch(() => {});
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

function webLocks(): any {
  const locks: any = typeof navigator !== "undefined" ? (navigator as any).locks : null;
  return locks?.request ? locks : null;
}

/*──────────────────────────────────────────────────────────────────────────*/

//sends the due reports of one loop iteration, by seq. resolves true when the pass must stop (auth). every state write
//goes through updateReportSync and is awaited before the next report
async function processDue(gen: number, s: string, synced: { count: number }): Promise<boolean> {
  const now = deps.now();
  const due = (await listReports(s)).filter((r) => r.sync.state === ReportSyncState.queued && (!r.sync.next_at || Date.parse(r.sync.next_at) <= now));
  if (gen !== generation) return true;
  //a task whose report did not reach synced blocks the later reports of the same task in this pass; other tasks go on
  const blockedTasks = new Set<number>();

  for (const r of due) {
    if (gen !== generation) return true;
    if (r.scope !== s || blockedTasks.has(r.task_id)) continue;

    //the credentials are read per request, never stored with the report: no token, someone else's token or an expired
    //one parks the whole queue in auth without a request
    const token = currentToken();
    const jwt = decodeJwt(token);
    if (!token || !jwt || jwt.sub !== r.user_id || !tokenIsFresh(token, deps.now())) {
      await parkForAuth(s, token, null);
      return true;
    }

    await updateReportSync(s, r.operation_id, { state: ReportSyncState.syncing });
    if (gen !== generation) return true;
    //the lease fallback is refreshed per request, so a long queue on a slow lan does not lose the lock mid pass
    if (!webLocks()) await takeSyncLease(s, tabId, LEASE_MS, deps.now()).catch(() => {});

    const body = { ...r.payload, operation_id: r.operation_id, issuance_revision: r.issuance_revision ?? undefined, client_reported_at: r.client_reported_at };
    let res: { status: number; data: any };
    try {
      res = await deps.transport.post(`/delivery/tasks/${r.task_id}/attempts`, body, token, REQUEST_TIMEOUT_MS);
    } catch (e: any) {
      if (gen !== generation) return true;
      await retryLater(s, r, null, e?.message || "network error");
      setStatus({ reachable: false, last_error: e?.message || "network error" });
      blockedTasks.add(r.task_id);
      continue;
    }
    if (gen !== generation) return true;
    setStatus({ reachable: true });

    const result = await classify(s, r, res);
    if (result === "stop") return true;
    if (result === "synced") synced.count++;
    else blockedTasks.add(r.task_id);
  }
  return false;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the server's answer decides the state. anything the server did not clearly reject is retried: the operation id makes a
//resend safe. resolves with the state written, or "stop" when the pass must end (401)
async function classify(s: string, r: LocalReport, res: { status: number; data: any }): Promise<ReportSyncState | "stop"> {
  const { status: code, data } = res;
  const message = typeof data?.message === "string" ? data.message : Array.isArray(data?.message) ? data.message.join(", ") : null;

  if (code >= 200 && code < 300) {
    if (typeof data?.attempt_id === "number" && Object.values(AttemptOutcome).includes(data?.outcome)) {
      await updateReportSync(s, r.operation_id, { state: ReportSyncState.synced, next_at: null, last_error: null, http_status: code, conflict_code: null }, data as IAttemptResult);
      return ReportSyncState.synced;
    }
    await retryLater(s, r, code, "unreadable server answer");
    return ReportSyncState.queued;
  }
  if (code === 401) {
    await parkForAuth(s, currentToken(), message);
    return "stop";
  }
  if (code === 403 || code === 404) {
    await updateReportSync(s, r.operation_id, { state: ReportSyncState.forbidden, next_at: null, last_error: message, http_status: code });
    return ReportSyncState.forbidden;
  }
  if (code === 400) {
    await updateReportSync(s, r.operation_id, { state: ReportSyncState.invalid, next_at: null, last_error: message, http_status: code });
    return ReportSyncState.invalid;
  }
  if (code === 409) {
    const conflict_code = Object.values(ReportConflictCode).includes(data?.code) ? data.code : ReportConflictCode.task_closed;
    await updateReportSync(s, r.operation_id, { state: ReportSyncState.conflict, next_at: null, last_error: message, http_status: code, conflict_code });
    return ReportSyncState.conflict;
  }
  //408 / 425 / 429 / 5xx and anything unexpected
  await retryLater(s, r, code, message || `http ${code}`);
  return ReportSyncState.queued;
}

/*──────────────────────────────────────────────────────────────────────────*/

//exponential backoff with jitter: 30s, 1m, 2m ... capped at 15m, plus 0..30%. http_status null marks a network failure,
//the kind a reconnect trigger clears
async function retryLater(s: string, r: LocalReport, httpStatus: number | null, error: string) {
  const tries = r.sync.tries + 1;
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (tries - 1), BACKOFF_MAX_MS);
  const wait = base + Math.floor(base * 0.3 * deps.random());
  await updateReportSync(s, r.operation_id, { state: ReportSyncState.queued, tries, next_at: new Date(deps.now() + wait).toISOString(), last_error: error, http_status: httpStatus });
}

/*──────────────────────────────────────────────────────────────────────────*/

async function refreshCounts(s: string) {
  const rows = await listReports(s);
  const pending = rows.filter((r) => [ReportSyncState.queued, ReportSyncState.syncing, ReportSyncState.auth].includes(r.sync.state)).length;
  const attention = rows.filter((r) => [ReportSyncState.invalid, ReportSyncState.forbidden, ReportSyncState.conflict].includes(r.sync.state)).length;
  //a parked row keeps the flag up even when it was set before this pass; a fresh login clears it in requeueIfSameAccount
  const auth_required = status.auth_required || rows.some((r) => r.sync.state === ReportSyncState.auth);
  if (scope === s) setStatus({ pending, attention, auth_required });
}

/*──────────────────────────────────────────────────────────────────────────*/

//the 60s timer runs while something is queued or the server was unreachable: onLine is a hint, a request is the proof,
//and this is what re-probes the server after the queue drained on a network error
function scheduleTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!scope) return;
  const s = scope;
  listReports(s)
    .then((rows) => {
      if (scope !== s || timer) return;
      const queued = rows.some((r) => r.sync.state === ReportSyncState.queued);
      if (!queued && status.reachable !== false) return;
      timer = setTimeout(() => {
        timer = null;
        kickSync("timer").catch(() => {});
      }, TIMER_MS);
      timer.unref?.();
    })
    .catch(() => {});
}
