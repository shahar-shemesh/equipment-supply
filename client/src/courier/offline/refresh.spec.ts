import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB } from "idb";

import { ReportSyncState, TaskStatus } from "../../../../shared/@core";
import { PNG, SCOPE, courierUser, fullForm, makeTask, makeToken, setToken, snapshot } from "../../test/fixtures";
import { DB_NAME, MetaRow, closeDb, openCourierDb } from "./db";
import { tokenMatchesScope } from "./identity";
import { cacheTaskDetail, closeChannel, getDraft, getReport, listReports, putDraft, readBoard, readTask, refresh, refreshIfStale, submitReport, updateReportSync } from "./store";
import { getSyncStatus, resetSyncForTests } from "./sync";

//the complete refresh: atomic replace of the snapshot, what it prunes and what it must never touch

beforeEach(async () => {
  await closeDb();
  await deleteDB(DB_NAME);
  //no token: the default refresh source must stop before any request, jsdom's location would reach a real port 3000
  localStorage.clear();
});

afterEach(async () => {
  resetSyncForTests();
  closeChannel();
  await closeDb();
  vi.restoreAllMocks();
});

async function meta(): Promise<MetaRow> {
  const db = await openCourierDb();
  return db.get("meta", SCOPE);
}

const draft = { answers: {}, recipient_type: "customer" as any, recipient: { name: "", id_number: "", phone: "" }, signature_png: PNG, signature_strokes: [] };

/*──────────────────────────────────────────────────────────────────────────*/

describe("refresh", () => {
  it("a list of another courier row (the account's row moved on the server) never lands under this scope", async () => {
    expect(await refresh(SCOPE, async () => snapshot([makeTask(1)]))).toEqual({ ok: true });
    expect(await refresh(SCOPE, async () => snapshot([{ ...makeTask(2), courier_id: 4 }, makeTask(3)]))).toEqual({ ok: false, error: "scope_mismatch" });
    expect((await readBoard(SCOPE)).rows.map((r) => r.id)).toEqual([1]);
    expect((await meta()).last_error).toBe("scope_mismatch");
    expect(getSyncStatus().identity_lost).toBe(true);
    //a handover task carries no courier_id and is not a sign of another row
    expect(await refresh(SCOPE, async () => snapshot([makeTask(1), { ...makeTask(5), courier_id: null }]))).toEqual({ ok: true });
    expect((await readBoard(SCOPE)).rows.map((r) => r.id)).toEqual([1, 5]);
  });

  it("the default source refuses another account's token and leaves the snapshot alone", async () => {
    expect(await refresh(SCOPE, async () => snapshot([makeTask(1)]))).toEqual({ ok: true });
    const exp = Math.floor(Date.now() / 1000) + 3600;

    //a second tab still on courier 7 while courier 8 signed in: no request, nothing replaced, the status asks for a login
    setToken({ sub: 8, courier_id: 4, exp });
    expect(await refresh(SCOPE)).toEqual({ ok: false, error: "auth_required" });
    expect((await readBoard(SCOPE)).rows.map((r) => r.id)).toEqual([1]);
    expect((await meta()).last_error).toBe("auth_required");
    expect(getSyncStatus().auth_required).toBe(true);

    //the guard itself: the token of the scope's own account passes, whatever courier row it was signed with (the row can
    //change after the login, identity.ts); another account's does not (no request is made here, jsdom's location would
    //reach a real port 3000)
    expect(tokenMatchesScope(SCOPE, makeToken({ sub: 7, courier_id: 3, exp }))).toBe(true);
    expect(tokenMatchesScope(SCOPE, makeToken({ sub: 7, courier_id: 4, exp }))).toBe(true);
    expect(tokenMatchesScope(SCOPE, makeToken({ sub: 8, courier_id: 3, exp }))).toBe(false);
    expect(tokenMatchesScope(SCOPE, null)).toBe(false);
    localStorage.clear();
  });

  it("replaces the snapshot atomically and marks the dataset ready", async () => {
    expect((await readBoard(SCOPE)).ready).toBe(false);
    expect(await refresh(SCOPE, async () => snapshot([makeTask(1), makeTask(2)]))).toEqual({ ok: true });
    let board = await readBoard(SCOPE);
    expect(board.ready).toBe(true);
    expect(board.rows.map((r) => r.id)).toEqual([1, 2]);
    expect((await meta()).last_error).toBeNull();
    expect(getSyncStatus().reachable).toBe(true);

    //task 1 left (reassigned), task 3 arrived: the old row is gone, no leftovers
    await refresh(SCOPE, async () => snapshot([makeTask(3), makeTask(2)]));
    board = await readBoard(SCOPE);
    expect(board.rows.map((r) => r.id)).toEqual([2, 3]);
    expect((await readTask(SCOPE, 1)).task).toBeNull();
  });

  it("an invalid shape or a rows / counts mismatch keeps the old snapshot and sets meta.last_error", async () => {
    await refresh(SCOPE, async () => snapshot([makeTask(1)]));
    const before = await meta();

    const bad: any[] = [
      null,
      { rows: "x", counts: { all: 0 } },
      { rows: [makeTask(2)] },
      { rows: [{ id: "2" }], counts: { all: 1 } },
      { rows: [{ ...makeTask(2), issuance: null }], counts: { all: 1 } },
      { ...snapshot([makeTask(2), makeTask(3)]), counts: { all: 5, pending: 5, done: 0 } }, //a filtered page
    ];
    for (const res of bad) {
      const r = await refresh(SCOPE, async () => res);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/invalid snapshot/);
      expect((await readBoard(SCOPE)).rows.map((x) => x.id)).toEqual([1]);
      expect((await meta()).last_error).toMatch(/invalid snapshot/);
      expect((await meta()).refreshed_at).toBe(before.refreshed_at);
      expect((await meta()).ready).toBe(true);
    }

    //a thrown fetch behaves the same, with the message
    const r = await refresh(SCOPE, async () => {
      throw new Error("Network Error");
    });
    expect(r).toEqual({ ok: false, error: "Network Error" });
    expect((await meta()).last_error).toBe("Network Error");
    expect((await readBoard(SCOPE)).rows).toHaveLength(1);

    //a good one clears the error
    await refresh(SCOPE, async () => snapshot([makeTask(1)]));
    expect((await meta()).last_error).toBeNull();
  });

  it("a first refresh that fails leaves the dataset not ready", async () => {
    const r = await refresh(SCOPE, async () => {
      throw new Error("offline");
    });
    expect(r.ok).toBe(false);
    const board = await readBoard(SCOPE);
    expect(board.ready).toBe(false);
    expect(board.rows).toEqual([]);
    expect(board.refreshed_at).toBeNull();
  });

  it("prunes details of vanished tasks and keeps the rest", async () => {
    await refresh(SCOPE, async () => snapshot([makeTask(1, { status: TaskStatus.done }), makeTask(2, { status: TaskStatus.done })]));
    await cacheTaskDetail(SCOPE, { ...makeTask(1, { status: TaskStatus.done }), attempts: [{ id: 1, task_id: 1, outcome: "delivered" as any, recipient_type: "customer" as any, reported_at: "x", signature_png: PNG, items: [] }] });
    await cacheTaskDetail(SCOPE, makeTask(2, { status: TaskStatus.done }));
    expect((await readTask(SCOPE, 1)).detail_available).toBe(true);

    await refresh(SCOPE, async () => snapshot([makeTask(2, { status: TaskStatus.done })]));
    const db = await openCourierDb();
    expect(await db.get("task_details", [SCOPE, 1])).toBeUndefined();
    expect(await db.get("task_details", [SCOPE, 2])).toBeTruthy();
    expect((await readTask(SCOPE, 2)).detail_available).toBe(true);
  });

  it("keeps queued, conflict, invalid and forbidden reports of vanished tasks, and drafts; prunes synced ones", async () => {
    const tasks = [1, 2, 3, 4, 5, 6].map((n) => makeTask(n));
    await refresh(SCOPE, async () => snapshot(tasks));
    const ops: Record<string, string> = {};
    for (const [i, state] of [ReportSyncState.queued, ReportSyncState.conflict, ReportSyncState.invalid, ReportSyncState.forbidden, ReportSyncState.synced, ReportSyncState.synced].entries()) {
      const r = await submitReport(SCOPE, courierUser, tasks[i], fullForm(tasks[i]));
      ops[state + i] = r.operation_id;
      const ack = state === ReportSyncState.synced ? { attempt_id: 1, outcome: "delivered" as any, task_id: tasks[i].id, reported_at: new Date().toISOString() } : undefined;
      if (state !== ReportSyncState.queued) await updateReportSync(SCOPE, r.operation_id, { state }, ack);
    }
    await putDraft(SCOPE, 7, draft);

    //every task leaves the list except task 6 (synced, still there)
    await refresh(SCOPE, async () => snapshot([makeTask(6, { status: TaskStatus.done })]));

    const left = await listReports(SCOPE);
    expect(left.map((r) => r.sync.state).sort()).toEqual([ReportSyncState.conflict, ReportSyncState.forbidden, ReportSyncState.invalid, ReportSyncState.queued, ReportSyncState.synced].sort());
    expect(left.find((r) => r.sync.state === ReportSyncState.synced).task_id).toBe(6);
    expect(await getReport(SCOPE, ops["synced4"])).toBeNull();
    expect((await getReport(SCOPE, ops["conflict1"])).payload.signature_png).toBe(PNG);
    expect((await getReport(SCOPE, ops["queued0"])).sync.state).toBe(ReportSyncState.queued);
    expect(await getDraft(SCOPE, 7)).toBeTruthy();

    //a synced report older than the retention goes even when its task is still listed
    await updateReportSync(SCOPE, ops["synced5"], {}, { attempt_id: 1, outcome: "delivered" as any, task_id: 6, reported_at: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString() });
    await refresh(SCOPE, async () => snapshot([makeTask(6, { status: TaskStatus.done })]));
    expect(await getReport(SCOPE, ops["synced5"])).toBeNull();
    expect(await listReports(SCOPE)).toHaveLength(4);
  });

  it("concurrent calls share one fetch", async () => {
    let resolve: (v: any) => void;
    const fetchAll = vi.fn(() => new Promise<any>((r) => (resolve = r)));
    const a = refresh(SCOPE, fetchAll);
    const b = refresh(SCOPE, fetchAll);
    expect(fetchAll).toHaveBeenCalledTimes(1);
    resolve(snapshot([makeTask(1)]));
    expect(await Promise.all([a, b])).toEqual([{ ok: true }, { ok: true }]);
    //after it settled a new call fetches again
    await refresh(SCOPE, fetchAll.mockResolvedValue(snapshot([])) as any);
    expect(fetchAll).toHaveBeenCalledTimes(2);
  });

  it("refreshIfStale skips inside the window", async () => {
    const fetchAll = vi.fn(async () => snapshot([makeTask(1)]));
    expect(await refreshIfStale(SCOPE, 60_000)).toEqual({ ok: false, error: expect.any(String) }); //no fetch injected, no token, the default get is skipped up front
    await refresh(SCOPE, fetchAll);
    expect(await refreshIfStale(SCOPE, 60_000)).toEqual({ ok: true, skipped: true });
    expect(fetchAll).toHaveBeenCalledTimes(1);
    //an old refreshed_at goes through (the default fetch fails without a token, that is the proof it was attempted)
    const db = await openCourierDb();
    const m = await db.get("meta", SCOPE);
    await db.put("meta", { ...m, refreshed_at: new Date(Date.now() - 120_000).toISOString() });
    const r = await refreshIfStale(SCOPE, 60_000);
    expect(r.skipped).toBeUndefined();
    expect(r.ok).toBe(false);
    expect((await db.get("meta", SCOPE)).last_error).toBe("auth_required");
  });

  it("a response that still shows the task pending while a local report is queued keeps the overlay done and the report untouched", async () => {
    const t = makeTask(1);
    await refresh(SCOPE, async () => snapshot([t, makeTask(2)]));
    const report = await submitReport(SCOPE, courierUser, t, fullForm(t));
    //the server has not seen the report yet (or the response crossed the send)
    await refresh(SCOPE, async () => snapshot([makeTask(1), makeTask(2)]));

    const board = await readBoard(SCOPE);
    expect(board.counts).toEqual({ all: 2, pending: 1, done: 1 });
    expect(board.rows.find((r) => r.id === 1).status).toBe(TaskStatus.done);
    const again = await getReport(SCOPE, report.operation_id);
    expect(again).toEqual(report);
    const task = await readTask(SCOPE, 1);
    expect(task.task.attempts[0].signature_png).toBe(PNG);
    expect(task.local_report.sync.state).toBe(ReportSyncState.queued);
  });
});
