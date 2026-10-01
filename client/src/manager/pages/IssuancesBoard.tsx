import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Snackbar } from "@mui/material";
import QrCodeScannerIcon from "@mui/icons-material/QrCodeScanner";

import { IIssuance, ISortState } from "../../../../shared/@core";
import { get, patch, post, errorMessage } from "../../utils/service";
import { formatDateTime } from "../../utils/format";
import { BoardFilters, emptyFilters } from "../components/BoardFilters";
import { IssuancesTable, RowAction } from "../components/IssuancesTable";
import { SideWidgets } from "../components/SideWidgets";
import { AssignCourierDialog } from "../components/AssignCourierDialog";
import { IssuanceDetailDialog } from "../components/IssuanceDetailDialog";
import { FindNumberDialog } from "../../components/FindNumberDialog";

const PAGE_SIZE = 15; //the design shows 15 rows a page

//לוח ניהול הנפקות - the manager home. table + filters + the two side widgets + a bottom bar for bulk actions
export default function IssuancesBoard() {
  const { t } = useTranslation();

  const [filters, setFilters] = useState<any>(emptyFilters);
  const [sort, setSort] = useState<ISortState>(null); //null = the server's default order, urgent first then by date
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: IIssuance[]; total: number }>({ rows: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [couriers, setCouriers] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>({ by_city: [], cities: [] });
  const [updatedAt, setUpdatedAt] = useState<Date>(null);
  const [assignIds, setAssignIds] = useState<number[]>(null); //null = dialog closed
  const [detailId, setDetailId] = useState<number>(null);
  const [finding, setFinding] = useState(false);
  const [toast, setToast] = useState<{ text: string; severity: "success" | "error" }>(null);

  async function load() {
    setLoading(true);
    try {
      const params = { ...filters, sort: sort?.key, order: sort?.dir, page, page_size: PAGE_SIZE };
      const [res, c, s] = await Promise.all([get("/issuances", params), get("/couriers"), get("/issuances/summary")]);
      // console.log("board data", res);
      setData(res);
      setCouriers(c);
      setSummary(s);
      setUpdatedAt(new Date());
      //rows that left the page (filter change, status change) leave the selection too
      setSelected((ids) => ids.filter((id) => res.rows.some((r) => r.id === id)));
    } catch (e) {
      setToast({ text: errorMessage(e), severity: "error" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [filters, page, sort]);

  function changeFilters(next: any) {
    setFilters(next);
    setPage(1);
  }

  function changeSort(next: ISortState) {
    setSort(next);
    setPage(1);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  async function markUrgent(ids: number[]) {
    try {
      await post("/issuances/mark-urgent", { ids });
      setSelected([]);
      load();
    } catch (e) {
      setToast({ text: errorMessage(e), severity: "error" });
    }
  }

  async function selfPickup(id: number) {
    try {
      await patch(`/issuances/${id}`, { self_pickup: true });
      setToast({ text: t("self_pickup_done"), severity: "success" });
      load();
    } catch (e) {
      setToast({ text: errorMessage(e), severity: "error" });
    }
  }

  //the kebab menu on a row
  function onRowAction(action: RowAction, row: IIssuance) {
    switch (action) {
      case "change_date":
      case "delete":
        setDetailId(row.id);
        break;
      case "self_pickup":
        selfPickup(row.id);
        break;
      case "mark_urgent":
        markUrgent([row.id]);
        break;
      case "change_courier":
        setAssignIds([row.id]);
        break;
    }
  }

  const from = data.total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(page * PAGE_SIZE, data.total);
  const lastPage = Math.max(Math.ceil(data.total / PAGE_SIZE), 1);

  return (
    <div className="board">
      <div className="board__main">
        <div className="board__title-row">
          <div>
            <h1>{t("board_title")}</h1>
            <div className="board__updated">{updatedAt ? t("board_updated_at", { time: formatDateTime(updatedAt) }) : t("loading")}</div>
          </div>
          <Button variant="contained" className="board__find" startIcon={<QrCodeScannerIcon />} onClick={() => setFinding(true)}>
            {t("find_issuance")}
          </Button>
        </div>

        <BoardFilters filters={filters} cities={summary.cities} onChange={changeFilters} />

        <div className="board__range">
          <span>{t("board_range", { from, to, total: data.total })}</span>
          <button type="button" className="board__page-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>{"›"}</button>
          <button type="button" className="board__page-btn" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>{"‹"}</button>
        </div>

        <IssuancesTable
          rows={data.rows}
          loading={loading}
          selected={selected}
          onSelect={setSelected}
          sort={sort}
          onSort={changeSort}
          onOpen={(row) => setDetailId(row.id)}
          onAction={onRowAction}
        />
      </div>

      <SideWidgets couriers={couriers} byCity={summary.by_city} />

      {finding && <FindNumberDialog lookup={async (number) => {
        //Exact number lookup ignores the board filters and stays behind the manager API guard.
        const res = await get("/issuances", { number, page_size: 1 });
        if (!res.rows.length) throw new Error(t("find_not_found"));
        return res.rows[0].id;
      }} onClose={() => setFinding(false)} onFound={setDetailId} />}

      {selected.length > 0 && (
        <div className="board__bottom-bar">
          <strong>{t("selected_count", { count: selected.length })}</strong>
          <Button variant="contained" onClick={() => setAssignIds(selected)}>{t("assign_courier")}</Button>
          <Button variant="outlined" onClick={() => markUrgent(selected)}>{t("mark_urgent")}</Button>
          <Button variant="text" onClick={() => setSelected([])}>{t("clear_selection")}</Button>
        </div>
      )}

      <AssignCourierDialog
        ids={assignIds}
        couriers={couriers}
        onClose={() => setAssignIds(null)}
        onDone={() => {
          setAssignIds(null);
          setSelected([]);
          setToast({ text: t("assign_done"), severity: "success" });
          load();
        }}
      />

      <IssuanceDetailDialog
        id={detailId}
        onClose={() => setDetailId(null)}
        onChanged={load}
        onAssign={(id) => setAssignIds([id])}
      />

      <Snackbar open={!!toast} autoHideDuration={4000} onClose={() => setToast(null)} anchorOrigin={{ vertical: "top", horizontal: "center" }}>
        <Alert severity={toast?.severity || "info"} onClose={() => setToast(null)}>{toast?.text}</Alert>
      </Snackbar>
    </div>
  );
}
