import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteDB } from "idb";

import { DB_NAME, closeDb, openCourierDb, scopeRange, storageError, writeTx } from "./db";
import { closeChannel } from "./store";
import { resetSyncForTests } from "./sync";

//the database layout and the helpers every store function leans on

beforeEach(async () => {
  await closeDb();
  await deleteDB(DB_NAME);
});

afterEach(async () => {
  resetSyncForTests();
  closeChannel();
  await closeDb();
});

describe("es-courier database", () => {
  it("creates the five stores with their keys and indexes", async () => {
    const db = await openCourierDb();
    expect(Array.from(db.objectStoreNames).sort()).toEqual(["drafts", "meta", "reports", "task_details", "tasks"]);
    const tx = db.transaction(["meta", "tasks", "task_details", "drafts", "reports"]);
    expect(tx.objectStore("meta").keyPath).toBe("scope");
    expect(tx.objectStore("tasks").keyPath).toEqual(["scope", "task_id"]);
    expect(Array.from(tx.objectStore("tasks").indexNames)).toEqual(["by_scope"]);
    expect(tx.objectStore("task_details").keyPath).toEqual(["scope", "task_id"]);
    expect(tx.objectStore("drafts").keyPath).toEqual(["scope", "task_id"]);
    expect(tx.objectStore("reports").keyPath).toEqual(["scope", "operation_id"]);
    expect(Array.from(tx.objectStore("reports").indexNames).sort()).toEqual(["by_scope", "by_task"]);
    expect(tx.objectStore("reports").index("by_task").keyPath).toEqual(["scope", "task_id"]);
    await tx.done;
  });

  it("shares one connection and reopens after close", async () => {
    const a = await openCourierDb();
    const b = await openCourierDb();
    expect(a).toBe(b);
    await closeDb();
    const c = await openCourierDb();
    expect(c).not.toBe(a);
    expect(c.objectStoreNames.contains("reports")).toBe(true);
  });

  it("scopeRange deletes one scope and leaves the others alone", async () => {
    await writeTx(["tasks"], async (tx) => {
      const s = tx.objectStore("tasks");
      await s.put({ scope: "1:1", task_id: 1, position: 0 });
      await s.put({ scope: "1:1", task_id: 99999, position: 1 });
      await s.put({ scope: "1:10", task_id: 1, position: 0 }); //a scope that shares the prefix, must survive
      await s.put({ scope: "2:2", task_id: 1, position: 0 });
    });
    await writeTx(["tasks"], async (tx) => {
      await tx.objectStore("tasks").delete(scopeRange("1:1"));
    });
    const db = await openCourierDb();
    const left = await db.getAll("tasks");
    expect(left.map((r) => r.scope).sort()).toEqual(["1:10", "2:2"]);
  });

  it("writeTx commits before resolving and rolls back on abort or throw", async () => {
    await writeTx(["drafts"], async (tx) => {
      await tx.objectStore("drafts").put({ scope: "1:1", task_id: 1, answers: {} });
    });
    const db = await openCourierDb();
    expect(await db.get("drafts", ["1:1", 1])).toBeTruthy();

    //an intentional abort keeps the return value and writes nothing
    const r = await writeTx(["drafts"], async (tx, abort) => {
      await tx.objectStore("drafts").put({ scope: "1:1", task_id: 2, answers: {} });
      abort();
      return "blocked";
    });
    expect(r).toBe("blocked");
    expect(await db.get("drafts", ["1:1", 2])).toBeUndefined();

    //a throw aborts and rethrows the caller's error as is
    await expect(
      writeTx(["drafts"], async (tx) => {
        await tx.objectStore("drafts").put({ scope: "1:1", task_id: 3, answers: {} });
        throw { blocked: "locked" };
      })
    ).rejects.toEqual({ blocked: "locked" });
    expect(await db.get("drafts", ["1:1", 3])).toBeUndefined();
  });

  it("maps indexeddb errors to the i18n keys", () => {
    expect(storageError(new DOMException("full", "QuotaExceededError"))).toBe("storage_quota");
    expect(storageError({ target: { error: { name: "QuotaExceededError" } } })).toBe("storage_quota");
    expect(storageError(new DOMException("closed", "InvalidStateError"))).toBe("storage_unavailable");
    expect(storageError(new DOMException("?", "UnknownError"))).toBe("storage_unavailable");
    expect(storageError(new Error("boom"))).toBe("local_save_failed");
    expect(storageError(null)).toBe("local_save_failed");
  });
});
