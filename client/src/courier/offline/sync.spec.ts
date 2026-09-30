import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB } from "idb";

import { AttemptOutcome, ConflictReviewStatus, EvidenceUploadState, ReportConflictCode, ReportSyncState } from "../../../../shared/@core";
import { PNG, SCOPE, courierUser, deferred, fullForm, makeTask, setToken, snapshot, tick } from "../../test/fixtures";
import { DB_NAME, closeDb, openCourierDb } from "./db";
import { closeChannel, evidenceOf, getReport, listReports, readBoard, refresh, retryEvidence, retryReport, submitReport, updateReportSync } from "./store";
import { SyncStatus, Transport, getSyncStatus, kickSync, resetSyncForTests, startSync, stopSync, subscribeSync } from "./sync";

//the worker against a fake transport: what goes out, how every answer is classified, what a reconnect and a re-login do

const T = Date.parse("2026-09-28T10:00:00.000Z");
const now = () => T;
const freshExp = Math.floor(T / 1000) + 12 * 3600;

let attemptId = 0;
function ok(task_id: number) {
  attemptId++;
  return { status: 201, data: { attempt_id: attemptId, outcome: AttemptOutcome.delivered, task_id, reported_at: "2026-09-28T10:00:05.000Z", operation_id: "x" } };
}

/*──────────────────────────────────────────────────────────────────────────*/

let conflictId = 500;
//the receipt of POST .../conflicts, the default answer for an evidence upload
function receipt(url: string, body: any) {
  conflictId++;
  return { status: 201, data: { kind: "conflict_recorded", conflict_id: conflictId, operation_id: body.operation_id, task_id: Number(url.split("/")[3]), received_at: "2026-09-28T10:00:07.000Z", review_status: ConflictReviewStatus.pending, reviewed_at: null } };
}

//a transport whose answers the test scripts per call: a status number, a full { status, data }, an Error to throw, or a
//promise to hold the request in flight. `getScript` does the same for the review status reads (default: an empty list)
function fakeTransport(script: any[] = [], getScript: any[] = []) {
  const calls: { url: string; body: any; token: string }[] = [];
  const post = vi.fn(async (url: string, body: any, token: string) => {
    calls.push({ url, body, token });
    const next = script.length ? script.shift() : url.endsWith("/conflicts") ? receipt(url, body) : ok(body.__task ?? Number(url.split("/")[3]));
    const answer = typeof next === "function" ? next(url, body) : next;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return answer === 201 ? ok(Number(url.split("/")[3])) : { status: answer, data: { statusCode: answer, message: `http ${answer}` } };
    return answer;
  });
  const get = vi.fn(async (url: string, params: any, token: string) => {
    const next = getScript.length ? getScript.shift() : { status: 200, data: [] };
    const answer = typeof next === "function" ? next(url, params) : next;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { post, get, calls, transport: { post, get } as Transport };
}

/*──────────────────────────────────────────────────────────────────────────*/

beforeEach(async () => {
  resetSyncForTests();
  await closeDb();
  await deleteDB(DB_NAME);
  localStorage.clear();
  setToken({ sub: 7, exp: freshExp });
  attemptId = 0;
  conflictId = 500;
});

afterEach(async () => {
  resetSyncForTests();
  closeChannel();
  await closeDb();
  vi.restoreAllMocks();
});

async function seed(ids: number[]) {
  const tasks = ids.map((id) => makeTask(id, { revision: 4 }));
  await refresh(SCOPE, async () => snapshot(tasks));
  const reports = [];
  for (const t of tasks) reports.push(await submitReport(SCOPE, courierUser, t, fullForm(t)));
  return { tasks, reports };
}

/*──────────────────────────────────────────────────────────────────────────*/

describe("sync worker", () => {
  it("sends a queued report once with the operation id, revision, client time and the stored signature, then stores the ack", async () => {
    const { reports } = await seed([1]);
    const { post, calls, transport } = fakeTransport();
    const afterSynced = vi.fn();
    await startSync(SCOPE, { transport, now, random: () => 0, afterSynced });

    expect(post).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe("/delivery/tasks/1/attempts");
    expect(calls[0].token).toBe(localStorage.getItem("es_token"));
    expect(calls[0].body).toMatchObject({
      operation_id: reports[0].operation_id,
      issuance_revision: 4,
      client_reported_at: reports[0].client_reported_at,
      signature_png: PNG,
      recipient_type: "customer",
      items: reports[0].payload.items,
    });
    expect(calls[0].body.signature_png).toBe(reports[0].payload.signature_png);

    const r = await getReport(SCOPE, reports[0].operation_id);
    expect(r.sync.state).toBe(ReportSyncState.synced);
    expect(r.sync.http_status).toBe(201);
    expect(r.ack).toEqual({ attempt_id: 1, outcome: "delivered", task_id: 1, reported_at: "2026-09-28T10:00:05.000Z", operation_id: "x" });
    expect(afterSynced).toHaveBeenCalledTimes(1);
    expect(afterSynced).toHaveBeenCalledWith(SCOPE);
    const status = getSyncStatus();
    expect(status).toMatchObject({ scope: SCOPE, running: false, reachable: true, auth_required: false, pending: 0, attention: 0, last_sync_at: new Date(T).toISOString() });

    //the board shows the ack's attempt id now
    const board = await readBoard(SCOPE);
    expect(board.rows[0].attempts[0].id).toBe(1);
    expect(board.rows[0].local_report.state).toBe(ReportSyncState.synced);
  });

  it("a report enqueued during a running pass goes out in the same pass", async () => {
    const { tasks } = await seed([1]);
    const hold = deferred<any>();
    const { post, transport } = fakeTransport([() => hold.promise]);
    const started = startSync(SCOPE, { transport, now, random: () => 0 });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(getSyncStatus().running).toBe(true);

    const t2 = makeTask(2);
    await refresh(SCOPE, async () => snapshot([...tasks, t2]));
    const second = await submitReport(SCOPE, courierUser, t2, fullForm(t2));
    await tick(20);
    expect(post).toHaveBeenCalledTimes(1);
    hold.resolve(ok(1));
    await started;

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].operation_id).toBe(second.operation_id);
    expect((await listReports(SCOPE)).map((r) => r.sync.state)).toEqual([ReportSyncState.synced, ReportSyncState.synced]);
  });

  it("a network error backs off with http_status null and an online event resends at once", async () => {
    const { reports } = await seed([1]);
    const { post, transport } = fakeTransport([new Error("Network Error")]);
    await startSync(SCOPE, { transport, now, random: () => 0 });

    let r = await getReport(SCOPE, reports[0].operation_id);
    expect(r.sync).toMatchObject({ state: ReportSyncState.queued, tries: 1, http_status: null, last_error: "Network Error", next_at: new Date(T + 30_000).toISOString() });
    expect(getSyncStatus()).toMatchObject({ reachable: false, pending: 1 });

    //a second pass without a reconnect leaves it waiting
    await kickSync("timer");
    expect(post).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect((await getReport(SCOPE, reports[0].operation_id)).sync.state).toBe(ReportSyncState.synced));
    r = await getReport(SCOPE, reports[0].operation_id);
    expect(r.sync.next_at).toBeNull();
    expect(post.mock.calls[1][1].operation_id).toBe(reports[0].operation_id);
    expect(getSyncStatus().reachable).toBe(true);
  });

  it("a start (app open or re login) drops a network backoff and sends at once", async () => {
    const { reports } = await seed([1]);
    const { post, transport } = fakeTransport([new Error("Network Error")]);
    await startSync(SCOPE, { transport, now, random: () => 0 });
    expect((await getReport(SCOPE, reports[0].operation_id)).sync.next_at).toBe(new Date(T + 30_000).toISOString());

    //the tablet was closed and opened again while the server was back, no online event ever fires for that
    stopSync();
    await startSync(SCOPE, { transport, now, random: () => 0 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].operation_id).toBe(reports[0].operation_id);
    expect((await getReport(SCOPE, reports[0].operation_id)).sync.state).toBe(ReportSyncState.synced);
  });

  it("a 5xx keeps its backoff through an online event, jitter is bounded, the cap is 15 minutes", async () => {
    const { reports } = await seed([1]);
    const { post, transport } = fakeTransport([503]);
    await startSync(SCOPE, { transport, now, random: () => 1 });
    let r = await getReport(SCOPE, reports[0].operation_id);
    expect(r.sync).toMatchObject({ state: ReportSyncState.queued, tries: 1, http_status: 503, last_error: "http 503", next_at: new Date(T + 39_000).toISOString() });

    window.dispatchEvent(new Event("online"));
    await kickSync("focus");
    await tick(20);
    expect(post).toHaveBeenCalledTimes(1);
    expect((await getReport(SCOPE, reports[0].operation_id)).sync.next_at).toBe(new Date(T + 39_000).toISOString());

    //the courier's retry button drops the schedule and the tries
    expect(await retryReport(SCOPE, reports[0].operation_id)).toBe(true);
    await kickSync("retry");
    expect(post).toHaveBeenCalledTimes(2);
    expect((await getReport(SCOPE, reports[0].operation_id)).sync.state).toBe(ReportSyncState.synced);

    //the cap: many tries never wait more than 15 minutes + jitter
    const db = await openCourierDb();
    const row = await db.get("reports", [SCOPE, reports[0].operation_id]);
    await db.put("reports", { ...row, sync: { ...row.sync, state: ReportSyncState.queued, tries: 20, next_at: null } });
    post.mockResolvedValueOnce({ status: 500, data: {} });
    await kickSync("timer");
    r = await getReport(SCOPE, reports[0].operation_id);
    expect(r.sync.tries).toBe(21);
    expect(Date.parse(r.sync.next_at) - T).toBe(15 * 60_000 + 15 * 60_000 * 0.3);
  });

  it("a 401 parks every queued report in auth and stops the pass; a fresh login of the same account resumes the same operation ids", async () => {
    const { reports } = await seed([1, 2]);
    const { post, transport } = fakeTransport([401]);
    const seen: SyncStatus[] = [];
    subscribeSync((s) => seen.push(s));
    await startSync(SCOPE, { transport, now, random: () => 0 });

    expect(post).toHaveBeenCalledTimes(1);
    expect((await listReports(SCOPE)).map((r) => r.sync.state)).toEqual([ReportSyncState.auth, ReportSyncState.auth]);
    expect(getSyncStatus()).toMatchObject({ auth_required: true, pending: 2 });
    expect(seen.some((s) => s.auth_required)).toBe(true);
    await kickSync("timer");
    expect(post).toHaveBeenCalledTimes(1);

    //another account signs in on the same device: nothing moves, nothing is sent with its token
    setToken({ sub: 99, courier_id: 9, exp: freshExp });
    await startSync(SCOPE, { transport, now, random: () => 0 });
    expect(post).toHaveBeenCalledTimes(1);
    expect((await listReports(SCOPE)).map((r) => r.sync.state)).toEqual([ReportSyncState.auth, ReportSyncState.auth]);
    expect(getSyncStatus().auth_required).toBe(true);

    //the courier signs in again
    setToken({ sub: 7, exp: freshExp + 100 });
    await startSync(SCOPE, { transport, now, random: () => 0 });
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls.slice(1).map((c) => c[1].operation_id)).toEqual(reports.map((r) => r.operation_id));
    expect(post.mock.calls[1][2]).toBe(localStorage.getItem("es_token"));
    expect((await listReports(SCOPE)).map((r) => r.sync.state)).toEqual([ReportSyncState.synced, ReportSyncState.synced]);
    expect(getSyncStatus()).toMatchObject({ auth_required: false, pending: 0 });
  });

  it("an expired or missing token parks the queue without a request", async () => {
    const { reports } = await seed([1]);
    setToken({ sub: 7, exp: Math.floor(T / 1000) - 10 });
    const { post, transport } = fakeTransport();
    await startSync(SCOPE, { transport, now, random: () => 0 });
    expect(post).not.toHaveBeenCalled();
    expect((await getReport(SCOPE, reports[0].operation_id)).sync.state).toBe(ReportSyncState.auth);
    expect(getSyncStatus().auth_required).toBe(true);

    //no token at all after a logout, same thing on the next start
    await retryReport(SCOPE, reports[0].operation_id);
    setToken(null);
    await startSync(SCOPE, { transport, now, random: () => 0 });
    expect(post).not.toHaveBeenCalled();
    expect((await getReport(SCOPE, reports[0].operation_id)).sync.state).toBe(ReportSyncState.auth);
  });

  it("a 409 becomes a conflict with the server's code and the other task's report still goes out", async () => {
    const { reports } = await seed([1, 2]);
    const { post, calls, transport } = fakeTransport([{ status: 409, data: { statusCode: 409, message: "task is no longer open", code: ReportConflictCode.task_cancelled } }]);
    const afterSynced = vi.fn();
    await startSync(SCOPE, { transport, now, random: () => 0, afterSynced });

    //two reports, then the evidence of the refused one goes out in the same pass
    expect(post).toHaveBeenCalledTimes(3);
    expect(calls[2].url).toBe("/delivery/tasks/1/conflicts");
    const [a, b] = await Promise.all(reports.map((r) => getReport(SCOPE, r.operation_id)));
    expect(a.sync).toMatchObject({ state: ReportSyncState.conflict, conflict_code: ReportConflictCode.task_cancelled, last_error: "task is no longer open", http_status: 409, next_at: null });
    expect(a.ack).toBeNull();
    expect(a.payload.signature_png).toBe(PNG);
    expect(b.sync.state).toBe(ReportSyncState.synced);
    expect(afterSynced).toHaveBeenCalledTimes(1);
    expect(getSyncStatus()).toMatchObject({ pending: 0, attention: 1 });

    //the snapshot task stays pending with the attention chip, no retry from a permanent state
    const board = await readBoard(SCOPE);
    expect(board.rows.find((r) => r.id === 1).status).toBe("pending");
    expect(board.rows.find((r) => r.id === 1).local_report.conflict_code).toBe(ReportConflictCode.task_cancelled);
    expect(await retryReport(SCOPE, a.operation_id)).toBe(false);
    await kickSync("retry");
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("a conflict survives a stop and a same account start, a refresh that lost its task, and is never resent", async () => {
    const { reports } = await seed([1]);
    const { post, transport } = fakeTransport([{ status: 409, data: { statusCode: 409, message: "task is no longer open", code: ReportConflictCode.task_closed } }]);
    await startSync(SCOPE, { transport, now, random: () => 0 });
    //the refused report and its evidence, nothing else ever again
    expect(post).toHaveBeenCalledTimes(2);
    expect((await getReport(SCOPE, reports[0].operation_id)).sync.state).toBe(ReportSyncState.conflict);

    //logout stops the worker, the login of the same account starts it again with a new token: a permanent state is not
    //a queued one, nothing goes out on the start, on a reconnect or on the courier's retry button
    stopSync();
    setToken({ sub: 7, exp: freshExp + 60 });
    await startSync(SCOPE, { transport, now, random: () => 0 });
    await kickSync("online");
    expect(await retryReport(SCOPE, reports[0].operation_id)).toBe(false);
    await kickSync("retry");
    expect(post).toHaveBeenCalledTimes(2);

    //the task left the server list (the other device closed it, the manager handled the issuance): the evidence stays as
    //it was signed, under its original task id, and the board counts it for attention
    await refresh(SCOPE, async () => snapshot([]));
    const kept = await getReport(SCOPE, reports[0].operation_id);
    expect(kept.sync).toMatchObject({ state: ReportSyncState.conflict, conflict_code: ReportConflictCode.task_closed, next_at: null });
    expect(kept).toMatchObject({ task_id: 1, issuance_revision: 4, ack: null });
    expect(kept.payload).toEqual(reports[0].payload);
    expect(kept.client_reported_at).toBe(reports[0].client_reported_at);
    expect((await listReports(SCOPE)).map((r) => r.operation_id)).toEqual([reports[0].operation_id]);
    expect((await readBoard(SCOPE)).rows).toEqual([]);
    expect(getSyncStatus()).toMatchObject({ pending: 0, attention: 1 });
  });

  it("a 409 without a code falls back to task_closed, 400 is invalid, 403 and 404 are forbidden", async () => {
    const { reports } = await seed([1, 2, 3, 4]);
    const { post, transport } = fakeTransport([
      { status: 409, data: { message: "task already closed" } },
      { status: 400, data: { statusCode: 400, message: ["expected 2 item answers, got 1"] } },
      403,
      404,
    ]);
    await startSync(SCOPE, { transport, now, random: () => 0 });
    //four reports, then the evidence of the one refused with a 409
    expect(post).toHaveBeenCalledTimes(5);
    const rows = await Promise.all(reports.map((r) => getReport(SCOPE, r.operation_id)));
    expect(rows[0].sync).toMatchObject({ state: ReportSyncState.conflict, conflict_code: ReportConflictCode.task_closed, last_error: "task already closed" });
    expect(rows[1].sync).toMatchObject({ state: ReportSyncState.invalid, last_error: "expected 2 item answers, got 1", http_status: 400 });
    expect(rows[2].sync).toMatchObject({ state: ReportSyncState.forbidden, http_status: 403 });
    expect(rows[3].sync).toMatchObject({ state: ReportSyncState.forbidden, http_status: 404 });
    expect(getSyncStatus()).toMatchObject({ pending: 0, attention: 4 });
  });

  it("a 2xx with an unreadable body is retried, not marked synced", async () => {
    const { reports } = await seed([1]);
    const { post, transport } = fakeTransport([{ status: 200, data: "<html>captive portal</html>" }]);
    await startSync(SCOPE, { transport, now, random: () => 0 });
    const r = await getReport(SCOPE, reports[0].operation_id);
    expect(r.sync).toMatchObject({ state: ReportSyncState.queued, tries: 1, http_status: 200, last_error: "unreadable server answer", next_at: new Date(T + 30_000).toISOString() });
    expect(r.ack).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("stopSync drops a late result, the next start resends the same operation id", async () => {
    const { reports } = await seed([1]);
    const hold = deferred<any>();
    const { post, transport } = fakeTransport([() => hold.promise]);
    const afterSynced = vi.fn();
    const started = startSync(SCOPE, { transport, now, random: () => 0, afterSynced });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((await getReport(SCOPE, reports[0].operation_id)).sync.state).toBe(ReportSyncState.syncing);

    stopSync();
    expect(getSyncStatus().scope).toBeNull();
    hold.resolve(ok(1));
    await started;
    await tick(20);
    const r = await getReport(SCOPE, reports[0].operation_id);
    expect(r.sync.state).toBe(ReportSyncState.syncing);
    expect(r.ack).toBeNull();
    expect(afterSynced).not.toHaveBeenCalled();

    //startup recovery: syncing is treated as queued and the SAME id goes out again
    await startSync(SCOPE, { transport, now, random: () => 0, afterSynced });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].operation_id).toBe(reports[0].operation_id);
    expect((await getReport(SCOPE, reports[0].operation_id)).sync.state).toBe(ReportSyncState.synced);
    expect(afterSynced).toHaveBeenCalledTimes(1);
  });

  it("afterSynced runs once for a pass that synced two reports, and never for a pass that synced none", async () => {
    await seed([1, 2]);
    const { post, transport } = fakeTransport();
    const afterSynced = vi.fn();
    await startSync(SCOPE, { transport, now, random: () => 0, afterSynced });
    expect(post).toHaveBeenCalledTimes(2);
    expect(afterSynced).toHaveBeenCalledTimes(1);
    await kickSync("timer");
    expect(afterSynced).toHaveBeenCalledTimes(1);
    expect(getSyncStatus().pending).toBe(0);
  });

  it("web locks: a second caller gets null and posts a kick, the holder's dirty loop picks the new row up", async () => {
    const held = new Set<string>();
    const request = vi.fn(async (name: string, _opts: any, cb: (lock: any) => Promise<void>) => {
      if (held.has(name)) return cb(null);
      held.add(name);
      try {
        return await cb({ name });
      } finally {
        held.delete(name);
      }
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    const other = new BroadcastChannel("es-courier");
    const messages: any[] = [];
    other.addEventListener("message", (e: MessageEvent) => messages.push(e.data));

    try {
      const { reports } = await seed([1]);
      //"another tab" holds the lock
      held.add("es-courier-sync:" + SCOPE);
      const { post, transport } = fakeTransport();
      await startSync(SCOPE, { transport, now, random: () => 0 });
      expect(request).toHaveBeenCalledWith("es-courier-sync:" + SCOPE, { ifAvailable: true }, expect.any(Function));
      expect(post).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(messages).toContainEqual({ type: "kick", scope: SCOPE }));
      expect((await getReport(SCOPE, reports[0].operation_id)).sync.state).toBe(ReportSyncState.queued);

      //now this tab is the holder, mid request, and the other tab writes a row and kicks
      held.clear();
      const hold = deferred<any>();
      const held2 = fakeTransport([() => hold.promise]);
      const started = startSync(SCOPE, { transport: held2.transport, now, random: () => 0 });
      await vi.waitFor(() => expect(held2.post).toHaveBeenCalledTimes(1));
      const db = await openCourierDb();
      const row = await db.get("reports", [SCOPE, reports[0].operation_id]);
      await db.put("reports", { ...row, operation_id: "other-tab-op-2", task_id: 2, issuance_id: 102, seq: row.seq + 1, sync: { ...row.sync, state: ReportSyncState.queued } });
      other.postMessage({ type: "kick", scope: SCOPE });
      await tick(50);
      hold.resolve(ok(1));
      await started;
      expect(held2.post).toHaveBeenCalledTimes(2);
      expect(held2.post.mock.calls[1][1].operation_id).toBe("other-tab-op-2");
      expect((await getReport(SCOPE, "other-tab-op-2")).sync.state).toBe(ReportSyncState.synced);
    } finally {
      other.close();
      delete (navigator as any).locks;
    }
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

//the evidence of a rejected report: sent once after the 409, kept with its receipt, never resent as a delivery report
describe("evidence of rejected reports", () => {
  const rejected = { status: 409, data: { statusCode: 409, message: "task is no longer open", code: ReportConflictCode.task_closed } };

  it("uploads the evidence in the same pass as the 409, keeps the receipt, and reads the review later", async () => {
    const { reports } = await seed([1, 2]);
    const reviewedAt = "2026-09-28T12:00:00.000Z";
    const { post, get, calls, transport } = fakeTransport([rejected], [{ status: 200, data: [] }, { status: 200, data: [{ operation_id: reports[0].operation_id, conflict_id: 501, received_at: "2026-09-28T10:00:07.000Z", review_status: ConflictReviewStatus.reviewed, reviewed_at: reviewedAt }] }]);
    await startSync(SCOPE, { transport, now, random: () => 0 });

    //report 1 refused, report 2 delivered, then the evidence of report 1: three requests, the last one to the conflicts route
    expect(post).toHaveBeenCalledTimes(3);
    expect(calls[2].url).toBe("/delivery/tasks/1/conflicts");
    expect(calls[2].body).toMatchObject({ operation_id: reports[0].operation_id, issuance_revision: 4, client_reported_at: reports[0].client_reported_at, signature_png: PNG });
    let r = await getReport(SCOPE, reports[0].operation_id);
    expect(r.sync.state).toBe(ReportSyncState.conflict);
    expect(evidenceOf(r)).toMatchObject({ state: EvidenceUploadState.received, conflict_id: 501, received_at: "2026-09-28T10:00:07.000Z", tries: 0 });
    expect(r.payload).toEqual(reports[0].payload);
    expect(getSyncStatus()).toMatchObject({ pending: 0, attention: 1 });
    //the first review read happened in that pass and said pending
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1]).toEqual({ operation_ids: reports[0].operation_id });

    //the next pass learns the manager marked it reviewed: no longer attention, the delivery state untouched
    await kickSync("focus");
    expect(get).toHaveBeenCalledTimes(2);
    r = await getReport(SCOPE, reports[0].operation_id);
    expect(evidenceOf(r)).toMatchObject({ state: EvidenceUploadState.reviewed, reviewed_at: reviewedAt });
    expect(r.sync.state).toBe(ReportSyncState.conflict);
    expect(getSyncStatus()).toMatchObject({ pending: 0, attention: 0 });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("a conflict stored before the evidence field existed is uploaded on the next start", async () => {
    const { reports } = await seed([1]);
    //what a device carries from before this version: the conflict, no `evidence` at all
    await updateReportSync(SCOPE, reports[0].operation_id, { state: ReportSyncState.conflict, conflict_code: ReportConflictCode.task_cancelled, http_status: 409 });
    expect((await getReport(SCOPE, reports[0].operation_id)).evidence).toBeUndefined();

    const { post, calls, transport } = fakeTransport();
    await startSync(SCOPE, { transport, now, random: () => 0 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe("/delivery/tasks/1/conflicts");
    expect(evidenceOf(await getReport(SCOPE, reports[0].operation_id)).state).toBe(EvidenceUploadState.received);
  });

  it("a lost upload response is retried with the same operation id and lands on the same receipt", async () => {
    const { reports } = await seed([1]);
    const { post, calls, transport } = fakeTransport([rejected, new Error("Network Error")]);
    await startSync(SCOPE, { transport, now, random: () => 0 });
    let e = evidenceOf(await getReport(SCOPE, reports[0].operation_id));
    expect(e).toMatchObject({ state: EvidenceUploadState.pending, tries: 1, http_status: null, next_at: new Date(T + 30_000).toISOString() });

    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    await vi.waitFor(async () => expect(evidenceOf(await getReport(SCOPE, reports[0].operation_id)).state).toBe(EvidenceUploadState.received));
    expect(calls[1].body.operation_id).toBe(calls[2].body.operation_id);
    e = evidenceOf(await getReport(SCOPE, reports[0].operation_id));
    expect(e.next_at).toBeNull();
  });

  it("a 401 pauses the upload without losing anything; the same account's new token sends it", async () => {
    const { reports } = await seed([1]);
    const { post, transport } = fakeTransport([rejected, 401]);
    await startSync(SCOPE, { transport, now, random: () => 0 });
    expect(getSyncStatus().auth_required).toBe(true);
    let r = await getReport(SCOPE, reports[0].operation_id);
    expect(r.sync.state).toBe(ReportSyncState.conflict);
    expect(evidenceOf(r).state).toBe(EvidenceUploadState.pending);
    expect(r.payload.signature_png).toBe(PNG);

    stopSync();
    setToken({ sub: 7, exp: freshExp + 60 });
    await startSync(SCOPE, { transport, now, random: () => 0 });
    expect(post).toHaveBeenCalledTimes(3);
    expect(evidenceOf(await getReport(SCOPE, reports[0].operation_id)).state).toBe(EvidenceUploadState.received);
  });

  it("another account's token sends nothing, and a refused upload does not block the next delivery report", async () => {
    const { reports, tasks } = await seed([1]);
    await updateReportSync(SCOPE, reports[0].operation_id, { state: ReportSyncState.conflict, conflict_code: ReportConflictCode.task_closed, http_status: 409 });
    setToken({ sub: 8, courier_id: 4 });
    const { post, transport } = fakeTransport([400]);
    await startSync(SCOPE, { transport, now, random: () => 0 });
    expect(post).not.toHaveBeenCalled();
    expect(evidenceOf(await getReport(SCOPE, reports[0].operation_id)).state).toBe(EvidenceUploadState.none);

    //the right account: the server refuses the evidence (400) and the row stays for attention, retryable by hand only
    setToken({ sub: 7, courier_id: 3 });
    await kickSync("online");
    expect(post).toHaveBeenCalledTimes(1);
    let e = evidenceOf(await getReport(SCOPE, reports[0].operation_id));
    expect(e).toMatchObject({ state: EvidenceUploadState.failed, http_status: 400 });
    await kickSync("timer");
    expect(post).toHaveBeenCalledTimes(1);

    //a new report of another task still goes out, then the manual retry sends the evidence again
    const t3 = makeTask(3, { revision: 4 });
    await refresh(SCOPE, async () => snapshot([...tasks, t3]));
    const third = await submitReport(SCOPE, courierUser, t3, fullForm(t3));
    await vi.waitFor(async () => expect((await getReport(SCOPE, third.operation_id)).sync.state).toBe(ReportSyncState.synced));
    expect(post).toHaveBeenCalledTimes(2);
    expect(await retryEvidence(SCOPE, reports[0].operation_id)).toBe(true);
    await kickSync("retry");
    expect(post).toHaveBeenCalledTimes(3);
    e = evidenceOf(await getReport(SCOPE, reports[0].operation_id));
    expect(e.state).toBe(EvidenceUploadState.received);
  });

  it("a receipt of kind delivered turns the report into a synced one instead of a conflict", async () => {
    const { reports } = await seed([1]);
    const delivered = { status: 201, data: { kind: "delivered", attempt_id: 77, outcome: AttemptOutcome.delivered, task_id: 1, reported_at: "2026-09-28T09:59:00.000Z", operation_id: reports[0].operation_id, replayed: true } };
    const { post, transport } = fakeTransport([rejected, delivered]);
    await startSync(SCOPE, { transport, now, random: () => 0 });
    expect(post).toHaveBeenCalledTimes(2);
    const r = await getReport(SCOPE, reports[0].operation_id);
    expect(r.sync.state).toBe(ReportSyncState.synced);
    expect(r.ack).toMatchObject({ attempt_id: 77, outcome: AttemptOutcome.delivered });
    expect(evidenceOf(r).state).toBe(EvidenceUploadState.none);
    expect(getSyncStatus()).toMatchObject({ pending: 0, attention: 0 });
  });
});
