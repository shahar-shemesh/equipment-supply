import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB } from "idb";

import { AttemptOutcome, IssuanceStatus, Priority, RecipientType, ReportSyncState, TaskStatus } from "../../../../shared/@core";
import { compareTasksForBoard, groupByAddress } from "../../../../shared/@utils";
import { OTHER_SCOPE, PNG, SCOPE, courierUser, failedForm, fullForm, makeTask, otherUser, partialForm, snapshot } from "../../test/fixtures";
import { DB_NAME, closeDb, openCourierDb } from "./db";
import { cacheTaskDetail, clearForeignScopes, clearSyncedData, closeChannel, deleteDraft, getDraft, getReport, listReports, lookupLocal, nothingDelivered, otherScopesWithPendingWork, putDraft, readBoard, readPendingIds, readTask, refresh, retryReport, requeueAuth, submitReport, updateReportSync, validateReportForm } from "./store";
import { resetSyncForTests } from "./sync";

//the data layer against fake-indexeddb: partitioning, the overlay, drafts, the atomic submit and the cleanup of a scope

beforeEach(async () => {
  await closeDb();
  await deleteDB(DB_NAME);
});

afterEach(async () => {
  resetSyncForTests();
  closeChannel();
  await closeDb();
  vi.restoreAllMocks();
});

const draft = (png = PNG) => ({ answers: { 11: { delivered: true } }, recipient_type: RecipientType.customer, recipient: { name: "", id_number: "", phone: "" }, signature_png: png, signature_strokes: [[{ x: 0.1, y: 0.2 }]] });

/*──────────────────────────────────────────────────────────────────────────*/

describe("scope partitioning", () => {
  it("two scopes never see each other's rows", async () => {
    const t1 = makeTask(1);
    const t2 = makeTask(2);
    await refresh(SCOPE, async () => snapshot([t1]));
    await refresh(OTHER_SCOPE, async () => snapshot([t2]));
    await submitReport(SCOPE, courierUser, t1, fullForm(t1));
    await putDraft(OTHER_SCOPE, 2, draft());

    const a = await readBoard(SCOPE);
    const b = await readBoard(OTHER_SCOPE);
    expect(a.rows.map((r) => r.id)).toEqual([1]);
    expect(b.rows.map((r) => r.id)).toEqual([2]);
    expect((await readTask(OTHER_SCOPE, 1)).task).toBeNull();
    expect(await listReports(OTHER_SCOPE)).toEqual([]);
    expect(await getDraft(SCOPE, 2)).toBeNull();
    expect(await lookupLocal(OTHER_SCOPE, t1.issuance.sap_number)).toBeNull();
  });

  it("a null or empty scope throws instead of partitioning under undefined", async () => {
    await expect(readBoard(null as any)).rejects.toThrow(/scope/);
    await expect(readTask("", 1)).rejects.toThrow(/scope/);
    await expect(refresh(undefined as any, async () => snapshot([]))).rejects.toThrow(/scope/);
    await expect(putDraft(null as any, 1, draft())).rejects.toThrow(/scope/);
    await expect(submitReport(null as any, courierUser, makeTask(1), fullForm(makeTask(1)))).rejects.toThrow(/scope/);
    await expect(listReports(null as any)).rejects.toThrow(/scope/);
  });

  it("otherScopesWithPendingWork sees the other scope's queued count and skips the current one", async () => {
    const t1 = makeTask(1);
    const t2 = makeTask(2);
    const t3 = makeTask(3);
    await submitReport(SCOPE, courierUser, t1, fullForm(t1));
    await submitReport(OTHER_SCOPE, otherUser, t2, fullForm(t2));
    const r3 = await submitReport(OTHER_SCOPE, otherUser, t3, fullForm(t3));
    await updateReportSync(OTHER_SCOPE, r3.operation_id, { state: ReportSyncState.conflict });

    expect(await otherScopesWithPendingWork(SCOPE)).toEqual([{ scope: OTHER_SCOPE, username: "gal", display_name: "גל משנע", count: 1 }]);
    const all = await otherScopesWithPendingWork();
    expect(all.map((x) => [x.scope, x.count]).sort()).toEqual([[SCOPE, 1], [OTHER_SCOPE, 1]]);
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("readTask", () => {
  it("a pending task never opened has everything the page needs from the list row", async () => {
    const t = makeTask(1);
    await refresh(SCOPE, async () => snapshot([t]));
    const r = await readTask(SCOPE, 1);
    expect(r.ready).toBe(true);
    expect(r.detail_available).toBe(true);
    expect(r.local_report).toBeNull();
    expect(r.task.status).toBe(TaskStatus.pending);
    expect(r.task.issuance.customer_name).toBe(t.issuance.customer_name);
    expect(r.task.issuance.items.map((i) => i.id)).toEqual(t.issuance.items.map((i) => i.id));
    expect(r.task.issuance.items[0].product_name).toBe("מוצר 1");
  });

  it("a done task without details reports detail_available false", async () => {
    await refresh(SCOPE, async () => snapshot([makeTask(1, { status: TaskStatus.done })]));
    const r = await readTask(SCOPE, 1);
    expect(r.task.status).toBe(TaskStatus.done);
    expect(r.detail_available).toBe(false);
  });

  it("a done snapshot task with a synced local report and no detail row shows the local attempt", async () => {
    const t = makeTask(1);
    await refresh(SCOPE, async () => snapshot([t]));
    const report = await submitReport(SCOPE, courierUser, t, partialForm(t));
    await updateReportSync(SCOPE, report.operation_id, { state: ReportSyncState.synced }, { attempt_id: 55, outcome: AttemptOutcome.partially_delivered, task_id: 1, reported_at: "2026-09-21T08:00:00.000Z" });
    //the refresh after the sync brings the task back as done, with a list attempt that has no items and no signature
    await refresh(SCOPE, async () => snapshot([makeTask(1, { status: TaskStatus.done })]));

    const r = await readTask(SCOPE, 1);
    expect(r.detail_available).toBe(true);
    expect(r.task.status).toBe(TaskStatus.done);
    expect(r.task.local_report.state).toBe(ReportSyncState.synced);
    expect(r.task.attempts).toHaveLength(1);
    expect(r.task.attempts[0].items).toEqual(report.payload.items);
    expect(r.task.attempts[0].signature_png).toBe(report.payload.signature_png);
    expect(r.task.attempts[0].id).toBe(55);
    expect(r.task.attempts[0].reported_at).toBe("2026-09-21T08:00:00.000Z");
  });

  it("recipient customer fills display.recipient from the issuance", async () => {
    const t = makeTask(1);
    await refresh(SCOPE, async () => snapshot([t]));
    const report = await submitReport(SCOPE, courierUser, t, fullForm(t));
    expect(report.display.recipient).toEqual({ name: t.issuance.customer_name, id_number: "012345678", phone: "050-1234567" });
    const r = await readTask(SCOPE, 1);
    expect(r.task.attempts[0].recipient_name).toBe(t.issuance.customer_name);
    expect(r.task.attempts[0].recipient_phone).toBe("050-1234567");

    //"אדם אחר" keeps what was typed
    const t2 = makeTask(2);
    const form = { ...fullForm(t2), recipient_type: RecipientType.other, recipient: { name: "שכן", id_number: "123456789", phone: "052-0000000" } };
    const other = await submitReport(SCOPE, courierUser, t2, form);
    expect(other.display.recipient).toEqual({ name: "שכן", id_number: "123456789", phone: "052-0000000" });
  });

  it("nothing delivered: no recipient and no signature are asked for, none leave the device", async () => {
    const t = makeTask(1);
    await refresh(SCOPE, async () => snapshot([t]));
    const form = { ...failedForm(t), recipient_type: RecipientType.other, recipient: { name: "", id_number: "", phone: "" }, signature_png: "" };
    expect(nothingDelivered(t, form.answers)).toBe(true);
    expect(validateReportForm(t, form)).toEqual({});

    //whatever the form still held is not sent: a drawn signature or a typed name from before the last line flipped
    const stale = { ...failedForm(t), recipient_type: RecipientType.other, recipient: { name: "שכן", id_number: "123456789", phone: "052-0000000" }, signature_png: PNG };
    const report = await submitReport(SCOPE, courierUser, t, stale);
    expect(report.outcome).toBe(AttemptOutcome.not_delivered);
    expect(report.payload).toEqual({ recipient_type: null, signature_png: null, items: report.payload.items });
    expect(report.display.recipient).toBeNull();
    const r = await readTask(SCOPE, 1);
    expect(r.task.attempts[0]).toMatchObject({ recipient_type: null, recipient_name: null, signature_png: null });

    //one delivered line brings both back, and an unanswered line keeps them
    const partial = partialForm(makeTask(2));
    expect(nothingDelivered(makeTask(2), partial.answers)).toBe(false);
    expect(validateReportForm(makeTask(2), { ...partial, signature_png: "" })).toEqual({ signature: "signature_missing" });
    const unanswered = failedForm(makeTask(3));
    delete unanswered.answers[makeTask(3).issuance.items[0].id];
    expect(nothingDelivered(makeTask(3), unanswered.answers)).toBe(false);
    expect(validateReportForm(makeTask(3), { ...unanswered, signature_png: "" })).toMatchObject({ signature: "signature_missing" });
  });

  it("a rejected report leaves the snapshot task pending and attaches local_report with the conflict code", async () => {
    const t = makeTask(1);
    await refresh(SCOPE, async () => snapshot([t]));
    const report = await submitReport(SCOPE, courierUser, t, fullForm(t));
    await updateReportSync(SCOPE, report.operation_id, { state: ReportSyncState.conflict, conflict_code: "task_cancelled" as any });
    const r = await readTask(SCOPE, 1);
    expect(r.task.status).toBe(TaskStatus.pending);
    expect(r.task.attempts).toEqual([]);
    expect(r.task.local_report).toMatchObject({ operation_id: report.operation_id, state: ReportSyncState.conflict, conflict_code: "task_cancelled" });
    expect(r.detail_available).toBe(true);
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("lookupLocal", () => {
  it("hits on the formatted number, misses on unknown numbers and other scopes", async () => {
    await refresh(SCOPE, async () => snapshot([makeTask(1, { sap_number: "1234567" })]));
    expect(await lookupLocal(SCOPE, "ס' 1234567")).toBe(1);
    expect(await lookupLocal(SCOPE, "1234567")).toBe(1);
    expect(await lookupLocal(SCOPE, "7654321")).toBeNull();
    expect(await lookupLocal(SCOPE, "")).toBeNull();
    expect(await lookupLocal(OTHER_SCOPE, "1234567")).toBeNull();
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("board overlay", () => {
  //urgent first, then by date with nulls last, then id; done rows after every pending row
  const rows = [
    makeTask(3, { priority: Priority.urgent, scheduled_date: "2026-09-30" }),
    makeTask(1, { scheduled_date: "2026-09-29" }),
    makeTask(4, { scheduled_date: "2026-09-29" }),
    makeTask(2),
    makeTask(5, { status: TaskStatus.done, priority: Priority.urgent }),
    makeTask(6, { status: TaskStatus.done }),
  ];

  it("compareTasksForBoard mirrors the server order", () => {
    const shuffled = [...rows].reverse().sort(compareTasksForBoard);
    expect(shuffled.map((r) => r.id)).toEqual([3, 1, 4, 2, 5, 6]);
  });

  it("counts, tabs, search and grouping come from the overlaid local set", async () => {
    const t1 = rows[1];
    const t4 = rows[2];
    //same customer + address as task 1, so the board groups them
    const grouped = { ...t4, issuance: { ...t4.issuance, customer_name: t1.issuance.customer_name, address_street: t1.issuance.address_street } };
    const list = [rows[0], t1, grouped, rows[3], rows[4], rows[5]];
    await refresh(SCOPE, async () => snapshot(list));

    let board = await readBoard(SCOPE);
    expect(board.ready).toBe(true);
    expect(board.refreshed_at).toBeTruthy();
    expect(board.counts).toEqual({ all: 6, pending: 4, done: 2 });
    expect(board.rows.map((r) => r.id)).toEqual([3, 1, 4, 2, 5, 6]);

    //a local report closes task 1 on screen: counters move, the row drops below the open ones and, like on the server,
    //below the urgent done task
    await submitReport(SCOPE, courierUser, t1, failedForm(t1));
    board = await readBoard(SCOPE);
    expect(board.counts).toEqual({ all: 6, pending: 3, done: 3 });
    expect(board.rows.map((r) => r.id)).toEqual([3, 4, 2, 5, 1, 6]);
    const closed = board.rows.find((r) => r.id === 1);
    expect(closed.status).toBe(TaskStatus.done);
    expect(closed.issuance.status).toBe(IssuanceStatus.not_delivered);
    expect(closed.local_report.state).toBe(ReportSyncState.queued);

    //tabs filter after counting, counts stay for the whole set
    const pending = await readBoard(SCOPE, "pending");
    expect(pending.rows.map((r) => r.id)).toEqual([3, 4, 2]);
    expect(pending.counts).toEqual({ all: 6, pending: 3, done: 3 });
    const done = await readBoard(SCOPE, "done");
    expect(done.rows.map((r) => r.id)).toEqual([5, 1, 6]);

    //search on the four fields, case insensitive, counts untouched
    expect((await readBoard(SCOPE, "all", "70000")).rows).toHaveLength(6);
    expect((await readBoard(SCOPE, "all", "700003")).rows.map((r) => r.id)).toEqual([3]);
    expect((await readBoard(SCOPE, "all", t1.issuance.customer_name)).rows.map((r) => r.id)).toEqual([4, 1]);
    expect((await readBoard(SCOPE, "all", "הרצל 2")).rows.map((r) => r.id)).toEqual([2]);
    expect((await readBoard(SCOPE, "pending", "תל אביב")).rows).toHaveLength(3);
    expect((await readBoard(SCOPE, "all", "אין כזה")).counts).toEqual({ all: 6, pending: 3, done: 3 });

    //grouping keeps the board order: the group of 1 + 4 sits where task 4 (its first row now) is
    const groups = groupByAddress((await readBoard(SCOPE)).rows);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([[3], [4, 1], [2], [5], [6]]);

    expect(await readPendingIds(SCOPE)).toEqual([3, 4, 2]);
  });

  it("a submitted report survives closing and reopening the database", async () => {
    const t = makeTask(1);
    await refresh(SCOPE, async () => snapshot([t, makeTask(2)]));
    const report = await submitReport(SCOPE, courierUser, t, fullForm(t));

    await closeDb();
    const board = await readBoard(SCOPE);
    expect(board.rows.find((r) => r.id === 1).status).toBe(TaskStatus.done);
    expect(board.counts).toEqual({ all: 2, pending: 1, done: 1 });
    const again = await getReport(SCOPE, report.operation_id);
    expect(again.operation_id).toBe(report.operation_id);
    expect(again.payload.signature_png).toBe(PNG);
    expect(again.sync.state).toBe(ReportSyncState.queued);
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("three outcomes", () => {
  it("full, partial and unsuccessful reports queue with the derived outcome", async () => {
    const t1 = makeTask(1);
    const t2 = makeTask(2);
    const t3 = makeTask(3);
    await refresh(SCOPE, async () => snapshot([t1, t2, t3]));
    const full = await submitReport(SCOPE, courierUser, t1, fullForm(t1));
    const partial = await submitReport(SCOPE, courierUser, t2, partialForm(t2));
    const failed = await submitReport(SCOPE, courierUser, t3, failedForm(t3));
    expect(full.outcome).toBe(AttemptOutcome.delivered);
    expect(partial.outcome).toBe(AttemptOutcome.partially_delivered);
    expect(failed.outcome).toBe(AttemptOutcome.not_delivered);
    expect(partial.payload.items).toEqual([{ item_id: 21, delivered: true }, { item_id: 22, delivered: false, reason: "nobody_home", reason_details: "לא היה אף אחד" }]);
    expect(failed.payload.items.every((i) => i.delivered === false && i.reason === "customer_refused")).toBe(true);

    const reports = await listReports(SCOPE);
    expect(reports.map((r) => r.sync.state)).toEqual([ReportSyncState.queued, ReportSyncState.queued, ReportSyncState.queued]);
    expect(reports.every((r) => r.sync.tries === 0 && r.ack === null && r.issuance_revision === 1 && r.user_id === 7 && r.courier_id === 3)).toBe(true);
    expect(new Set(reports.map((r) => r.operation_id)).size).toBe(3);
    expect(reports.every((r) => /^[A-Za-z0-9_-]{8,64}$/.test(r.operation_id))).toBe(true);

    const board = await readBoard(SCOPE);
    expect(board.rows.map((r) => r.issuance.status)).toEqual([IssuanceStatus.delivered, IssuanceStatus.partially_delivered, IssuanceStatus.not_delivered]);
  });

  it("validation rejects with the field map and writes nothing", async () => {
    const t = makeTask(1);
    const form = partialForm(t);
    form.answers[12] = { delivered: false };
    form.signature_png = "";
    await expect(submitReport(SCOPE, courierUser, t, { ...form, recipient_type: RecipientType.other })).rejects.toEqual({
      fields: { item_12: { reason: "required", reason_details: "required" }, recipient_name: "required", recipient_id_number: "required", recipient_phone: "required", signature: "signature_missing" },
    });
    expect(await listReports(SCOPE)).toEqual([]);
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("drafts", () => {
  it("put, read, blocked after submit, delete", async () => {
    const t = makeTask(1);
    await refresh(SCOPE, async () => snapshot([t]));
    expect(await putDraft(SCOPE, 1, draft())).toEqual({ blocked: false });
    const d = await getDraft(SCOPE, 1);
    expect(d.signature_strokes).toEqual([[{ x: 0.1, y: 0.2 }]]);
    expect(d.answers).toEqual({ 11: { delivered: true } });
    expect(d.updated_at).toBeTruthy();

    await submitReport(SCOPE, courierUser, t, fullForm(t));
    expect(await getDraft(SCOPE, 1)).toBeNull();
    //the late debounced write after send
    expect(await putDraft(SCOPE, 1, draft("data:image/png;base64,late"))).toEqual({ blocked: true });
    expect(await getDraft(SCOPE, 1)).toBeNull();

    //another task is not blocked, and delete works
    expect(await putDraft(SCOPE, 2, draft())).toEqual({ blocked: false });
    await deleteDraft(SCOPE, 2);
    expect(await getDraft(SCOPE, 2)).toBeNull();
  });

  it("a rejected report frees the task for a new draft", async () => {
    const t = makeTask(1);
    const r = await submitReport(SCOPE, courierUser, t, fullForm(t));
    await updateReportSync(SCOPE, r.operation_id, { state: ReportSyncState.invalid });
    expect(await putDraft(SCOPE, 1, draft())).toEqual({ blocked: false });
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("submitReport atomicity", () => {
  it("writes the report and removes the draft in one commit", async () => {
    const t = makeTask(1);
    await putDraft(SCOPE, 1, draft());
    const report = await submitReport(SCOPE, courierUser, t, fullForm(t));
    const db = await openCourierDb();
    expect(await db.get("reports", [SCOPE, report.operation_id])).toBeTruthy();
    expect(await db.get("drafts", [SCOPE, 1])).toBeUndefined();
    expect(report.client_reported_at).toBe(new Date(report.seq).toISOString());
  });

  it("a failing store write leaves no report, keeps the draft and rejects with a storage key", async () => {
    const t = makeTask(1);
    await putDraft(SCOPE, 1, draft());
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
      if (this.name === "reports") throw new DOMException("quota", "QuotaExceededError");
      return put.apply(this, args as any);
    });
    await expect(submitReport(SCOPE, courierUser, t, fullForm(t))).rejects.toEqual({ storage: "storage_quota" });
    vi.restoreAllMocks();
    expect(await listReports(SCOPE)).toEqual([]);
    expect(await getDraft(SCOPE, 1)).toBeTruthy();
    expect((await readTask(SCOPE, 1)).local_report).toBeNull();
  });

  it("two concurrent submits for one task leave exactly one row, the other rejects with blocked locked", async () => {
    const t = makeTask(1);
    const results = await Promise.allSettled([submitReport(SCOPE, courierUser, t, fullForm(t)), submitReport(SCOPE, courierUser, t, failedForm(t))]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toEqual({ blocked: "locked" });
    expect(await listReports(SCOPE)).toHaveLength(1);

    //and a third one after the fact is locked the same way, until the first is rejected by the server
    await expect(submitReport(SCOPE, courierUser, t, fullForm(t))).rejects.toEqual({ blocked: "locked" });
    const [first] = await listReports(SCOPE);
    await updateReportSync(SCOPE, first.operation_id, { state: ReportSyncState.forbidden });
    const second = await submitReport(SCOPE, courierUser, t, fullForm(t));
    expect(second.operation_id).not.toBe(first.operation_id);
    expect(await listReports(SCOPE)).toHaveLength(2);
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("retry helpers", () => {
  it("retryReport only from queued or auth, resets tries and next_at", async () => {
    const t = makeTask(1);
    const r = await submitReport(SCOPE, courierUser, t, fullForm(t));
    await updateReportSync(SCOPE, r.operation_id, { state: ReportSyncState.auth, tries: 3, next_at: "2099-01-01T00:00:00.000Z" });
    expect(await retryReport(SCOPE, r.operation_id)).toBe(true);
    expect((await getReport(SCOPE, r.operation_id)).sync).toMatchObject({ state: ReportSyncState.queued, tries: 0, next_at: null });

    for (const state of [ReportSyncState.conflict, ReportSyncState.invalid, ReportSyncState.forbidden, ReportSyncState.synced]) {
      await updateReportSync(SCOPE, r.operation_id, { state });
      expect(await retryReport(SCOPE, r.operation_id)).toBe(false);
      expect((await getReport(SCOPE, r.operation_id)).sync.state).toBe(state);
    }
    expect(await retryReport(SCOPE, "nope")).toBe(false);
  });

  it("requeueAuth only touches rows of the same user", async () => {
    const t = makeTask(1);
    const r = await submitReport(SCOPE, courierUser, t, fullForm(t));
    await updateReportSync(SCOPE, r.operation_id, { state: ReportSyncState.auth });
    expect(await requeueAuth(SCOPE, 8)).toBe(0);
    expect((await getReport(SCOPE, r.operation_id)).sync.state).toBe(ReportSyncState.auth);
    expect(await requeueAuth(SCOPE, 7)).toBe(1);
    expect((await getReport(SCOPE, r.operation_id)).sync.state).toBe(ReportSyncState.queued);
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

//what leaves the device on logout and under another account: the server's copies only
describe("clearSyncedData", () => {
  it("deletes the snapshot, the details and the synced reports; keeps every other state, the draft and the meta row that names them", async () => {
    const states = [ReportSyncState.synced, ReportSyncState.queued, ReportSyncState.syncing, ReportSyncState.auth, ReportSyncState.invalid, ReportSyncState.forbidden, ReportSyncState.conflict];
    const tasks = states.map((_, i) => makeTask(i + 1));
    await refresh(SCOPE, async () => snapshot([...tasks, makeTask(8)]));
    await cacheTaskDetail(SCOPE, makeTask(1, { status: TaskStatus.done }));
    for (let i = 0; i < states.length; i++) {
      const r = await submitReport(SCOPE, courierUser, tasks[i], fullForm(tasks[i]));
      await updateReportSync(SCOPE, r.operation_id, { state: states[i] });
    }
    await putDraft(SCOPE, 8, draft());

    expect(await clearSyncedData(SCOPE)).toEqual({ reports: 6, drafts: 1 });
    const db = await openCourierDb();
    expect(await db.getAllFromIndex("tasks", "by_scope", SCOPE)).toEqual([]);
    expect(await db.get("task_details", [SCOPE, 1])).toBeUndefined();
    const kept = await listReports(SCOPE);
    expect(kept.map((r) => r.sync.state)).toEqual(states.slice(1));
    expect(kept.every((r) => r.payload.signature_png === PNG)).toBe(true);
    expect((await getDraft(SCOPE, 8)).signature_strokes).toEqual([[{ x: 0.1, y: 0.2 }]]);
    //the meta row still names the owner, but no longer claims a snapshot that is gone
    expect(await db.get("meta", SCOPE)).toMatchObject({ username: "dan", display_name: "דן משנע", ready: false, refreshed_at: null, last_error: null });
    expect((await readBoard(SCOPE)).ready).toBe(false);
    expect(await otherScopesWithPendingWork()).toEqual([{ scope: SCOPE, username: "dan", display_name: "דן משנע", count: 3 }]);
  });

  it("deletes the meta row only when no report and no draft are left", async () => {
    const t = makeTask(1);
    await refresh(SCOPE, async () => snapshot([t]));
    const r = await submitReport(SCOPE, courierUser, t, fullForm(t));
    await updateReportSync(SCOPE, r.operation_id, { state: ReportSyncState.synced });
    await putDraft(SCOPE, 2, draft());

    //the draft alone keeps the row
    expect(await clearSyncedData(SCOPE)).toEqual({ reports: 0, drafts: 1 });
    const db = await openCourierDb();
    expect(await db.get("meta", SCOPE)).toBeTruthy();
    expect(await listReports(SCOPE)).toEqual([]);

    await deleteDraft(SCOPE, 2);
    expect(await clearSyncedData(SCOPE)).toEqual({ reports: 0, drafts: 0 });
    expect(await db.get("meta", SCOPE)).toBeUndefined();
    expect(await otherScopesWithPendingWork()).toEqual([]);

    //a scope that never stored anything is not an error, a missing scope is
    expect(await clearSyncedData(OTHER_SCOPE)).toEqual({ reports: 0, drafts: 0 });
    await expect(clearSyncedData(null as any)).rejects.toThrow(/scope/);
  });

  it("clearForeignScopes sweeps every other account and leaves the current one alone", async () => {
    const t1 = makeTask(1);
    const t2 = makeTask(2);
    const t3 = makeTask(3);
    await refresh(SCOPE, async () => snapshot([t1]));
    await refresh(OTHER_SCOPE, async () => snapshot([t2, t3]));
    const mine = await submitReport(SCOPE, courierUser, t1, fullForm(t1));
    await updateReportSync(SCOPE, mine.operation_id, { state: ReportSyncState.synced });
    const theirsTaken = await submitReport(OTHER_SCOPE, otherUser, t2, fullForm(t2));
    await updateReportSync(OTHER_SCOPE, theirsTaken.operation_id, { state: ReportSyncState.synced });
    const theirsQueued = await submitReport(OTHER_SCOPE, otherUser, t3, fullForm(t3));

    await clearForeignScopes(SCOPE);
    expect((await readBoard(SCOPE)).rows.map((r) => r.id)).toEqual([1]);
    expect((await listReports(SCOPE)).map((r) => r.sync.state)).toEqual([ReportSyncState.synced]);
    expect((await readBoard(OTHER_SCOPE)).rows).toEqual([]);
    expect((await listReports(OTHER_SCOPE)).map((r) => r.operation_id)).toEqual([theirsQueued.operation_id]);
    expect(await otherScopesWithPendingWork(SCOPE)).toEqual([{ scope: OTHER_SCOPE, username: "gal", display_name: "גל משנע", count: 1 }]);
  });
});
