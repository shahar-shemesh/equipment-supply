import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB } from "idb";

import { AttemptOutcome, ReportConflictCode, ReportSyncState } from "../../../../shared/@core";
import { PNG, SCOPE, courierUser, deferred, fullForm, makeTask, setToken, snapshot, tick } from "../../test/fixtures";
import { DB_NAME, closeDb, openCourierDb } from "./db";
import { closeChannel, getReport, listReports, readBoard, refresh, retryReport, submitReport } from "./store";
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

//a transport whose answers the test scripts per call: a status number, a full { status, data }, an Error to throw, or a
//promise to hold the request in flight
function fakeTransport(script: any[] = []) {
  const calls: { url: string; body: any; token: string }[] = [];
  const post = vi.fn(async (url: string, body: any, token: string) => {
    calls.push({ url, body, token });
    const next = script.length ? script.shift() : ok(body.__task ?? Number(url.split("/")[3]));
    const answer = typeof next === "function" ? next(url, body) : next;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return answer === 201 ? ok(Number(url.split("/")[3])) : { status: answer, data: { statusCode: answer, message: `http ${answer}` } };
    return answer;
  });
  return { post, calls, transport: { post } as Transport };
}

/*──────────────────────────────────────────────────────────────────────────*/

beforeEach(async () => {
  resetSyncForTests();
  await closeDb();
  await deleteDB(DB_NAME);
  localStorage.clear();
  setToken({ sub: 7, exp: freshExp });
  attemptId = 0;
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
    const { post, transport } = fakeTransport([{ status: 409, data: { statusCode: 409, message: "task is no longer open", code: ReportConflictCode.task_cancelled } }]);
    const afterSynced = vi.fn();
    await startSync(SCOPE, { transport, now, random: () => 0, afterSynced });

    expect(post).toHaveBeenCalledTimes(2);
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
    expect(post).toHaveBeenCalledTimes(2);
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
    expect(post).toHaveBeenCalledTimes(4);
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
