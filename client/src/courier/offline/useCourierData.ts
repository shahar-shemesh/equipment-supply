import { useEffect, useState } from "react";

import { TaskStatus } from "../../../../shared/@core";
import { LocalReport, storageError } from "./db";
import { currentToken, tokenIsFresh, tokenMatchesScope } from "./identity";
import { BoardData, ScopeWork, Tab, TaskData, cacheTaskDetail, listReports, otherScopesWithPendingWork, readBoard, readTask, refresh, subscribe } from "./store";
import { SyncStatus, getSyncStatus, offlineGet, subscribeSync } from "./sync";

//the screens read local data through these. each hook reads on mount and again on every store / sync event of its scope,
//and drops a result that arrives after unmount or after the arguments changed (the cancelled flag), so a slow read for
//task 5 never paints over task 6. `error` is an i18n key (storageError)

type Hook<T> = { data: T; loading: boolean; error: string | null };

function online() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the board of `scope` for the tab + search. data is null until the first read
export function useBoard(scope: string | null, tab: Tab, search: string): Hook<BoardData | null> {
  const [data, setData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setLoading(true);
    const load = () =>
      readBoard(scope, tab, search)
        .then((r) => {
          if (cancelled) return;
          setData(r);
          setError(null);
          setLoading(false);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(storageError(e));
          setLoading(false);
        });
    load();
    const unsubscribe = subscribe((e) => {
      if (e.scope === scope && e.kind !== "kick") load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [scope, tab, search]);

  return { data, loading, error };
}

/*──────────────────────────────────────────────────────────────────────────*/

//one task. when the task is missing and the device is online with a fresh token, one refresh runs before saying "not on
//this device" (a lookup may have found a task assigned after the last refresh). a done task without its report details
//fetches GET /delivery/tasks/:id through the interceptor free instance and caches it. data.task is null when the task is
//not on this device; data itself is null until the first read
export function useTask(scope: string | null, id: number): Hook<TaskData | null> {
  const [data, setData] = useState<TaskData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scope || !id) return;
    let cancelled = false;
    setLoading(true);
    setData(null);

    const reread = () =>
      readTask(scope, id)
        .then((r) => {
          if (cancelled) return;
          setData(r);
          setError(null);
        })
        .catch((e) => {
          if (!cancelled) setError(storageError(e));
        });

    async function load() {
      let r = await readTask(scope, id);
      if (cancelled) return;
      //no request for this scope under another account's token (a second tab after an account switch)
      const canFetch = online() && tokenIsFresh(currentToken()) && tokenMatchesScope(scope);
      if (!r.task && canFetch) {
        await refresh(scope);
        if (cancelled) return;
        r = await readTask(scope, id);
        if (cancelled) return;
      }
      if (r.task && r.task.status === TaskStatus.done && !r.detail_available && canFetch) {
        try {
          const detail = await offlineGet(`/delivery/tasks/${id}`);
          if (cancelled) return;
          await cacheTaskDetail(scope, detail);
          if (cancelled) return;
          r = await readTask(scope, id);
          if (cancelled) return;
        } catch (e) {
          //offline after all, or the task is not this courier's any more: the screen shows offline_detail_unavailable
        }
      }
      setData(r);
      setError(null);
    }

    load()
      .catch((e) => {
        if (!cancelled) setError(storageError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const unsubscribe = subscribe((e) => {
      if (e.scope === scope && e.kind !== "kick") reread();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [scope, id]);

  return { data, loading, error };
}

/*──────────────────────────────────────────────────────────────────────────*/

//the worker status, live. never loading, never errors
export function useSyncStatus(): Hook<SyncStatus> {
  const [data, setData] = useState<SyncStatus>(getSyncStatus);
  useEffect(() => subscribeSync(setData), []);
  return { data, loading: false, error: null };
}

/*──────────────────────────────────────────────────────────────────────────*/

//every report of the scope in enqueue order (the pending dialog). data is [] until the first read
export function useReports(scope: string | null): Hook<LocalReport[]> {
  const [data, setData] = useState<LocalReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    const load = () =>
      listReports(scope)
        .then((r) => {
          if (cancelled) return;
          setData(r);
          setError(null);
          setLoading(false);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(storageError(e));
          setLoading(false);
        });
    load();
    const unsubscribe = subscribe((e) => {
      if (e.scope === scope && e.kind !== "kick") load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [scope]);

  return { data, loading, error };
}

/*──────────────────────────────────────────────────────────────────────────*/

//other accounts on this device with reports waiting to be sent (the status bar notice). pass the current scope to leave
//it out, null on the login page to list everyone. re-read on every store event of any scope
export function useOtherAccountsWork(scope: string | null): Hook<ScopeWork[]> {
  const [data, setData] = useState<ScopeWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      otherScopesWithPendingWork(scope || undefined)
        .then((r) => {
          if (cancelled) return;
          setData(r);
          setError(null);
          setLoading(false);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(storageError(e));
          setLoading(false);
        });
    load();
    const unsubscribe = subscribe((e) => {
      if (e.kind !== "kick") load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [scope]);

  return { data, loading, error };
}
