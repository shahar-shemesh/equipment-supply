import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@mui/material";

import { IAuditEntry, IAuditPage } from "../../../../shared/@core";
import { errorMessage, get } from "../../utils/service";
import { AuditFilterState, AuditFilters, AuditRef, emptyAuditFilters, rangeInvalid, toAuditQuery } from "../components/AuditFilters";
import { AUDIT_PAGE_SIZE, AuditOrder, AuditTable } from "../components/AuditTable";
import { AuditDetailsDrawer } from "../components/AuditDetailsDrawer";

//יומן פעילות - the audit log, read only. the server owns every filter, the page and the order; this holds one page of
//rows and sends the parameters again on every change
export default function AuditPage() {
  const { t } = useTranslation();

  const [filters, setFilters] = useState<AuditFilterState>(emptyAuditFilters);
  const [page, setPage] = useState(1);
  const [order, setOrder] = useState<AuditOrder>("desc");
  const [data, setData] = useState<IAuditPage>({ items: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<IAuditEntry>(null);
  //two requests in flight answer in any order: only the newest one is applied, an older answer is dropped
  const seq = useRef(0);

  async function load() {
    //a window that ends before it starts is marked in the toolbar and never sent (the server would answer 400)
    if (rangeInvalid(filters)) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await get("/audit", { ...toAuditQuery(filters), order, page, size: AUDIT_PAGE_SIZE });
      if (mine !== seq.current) return;
      setData(res);
      setError("");
    } catch (e) {
      if (mine !== seq.current) return;
      //the previous rows stay under the alert
      setError(errorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [filters, page, order]);

  //the toolbar and the table are memoized (opening the drawer re-rendered the grid and the pickers for nothing, see
  //AuditTable.tsx), so the two callbacks they get keep their identity; the setters they close over never change
  const changeFilters = useCallback((next: AuditFilterState) => {
    setFilters(next);
    setPage(1);
  }, []);

  const changeOrder = useCallback((next: AuditOrder) => {
    setOrder(next);
    setPage(1);
  }, []);

  //the drawer's two buttons: the chip replaces the row's view of the log with the whole history of that issuance or user
  function filterIssuance(ref: AuditRef) {
    setOpen(null);
    changeFilters({ ...filters, issuance: ref });
  }

  function filterActor(ref: AuditRef) {
    setOpen(null);
    changeFilters({ ...filters, actor: ref });
  }

  return (
    <div className="audit-page">
      <div className="audit-page__title">
        <h1>{t("audit_title")}</h1>
        <p className="muted">{t("audit_subtitle")}</p>
      </div>

      <AuditFilters filters={filters} onChange={changeFilters} />

      {error && (
        //no retry while the range is invalid: load() would send nothing, the toolbar's own line says what to fix
        <Alert severity="error" className="audit-page__error" action={rangeInvalid(filters) ? null : <Button color="inherit" size="small" onClick={load}>{t("audit_retry")}</Button>}>
          {error}
        </Alert>
      )}

      <AuditTable
        rows={data.items}
        total={data.total}
        page={page}
        loading={loading}
        order={order}
        onPage={setPage}
        onOrder={changeOrder}
        onOpen={setOpen}
      />

      <AuditDetailsDrawer entry={open} onClose={() => setOpen(null)} onFilterIssuance={filterIssuance} onFilterActor={filterActor} />
    </div>
  );
}
