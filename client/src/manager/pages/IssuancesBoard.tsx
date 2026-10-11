import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Snackbar } from "@mui/material";
import QrCodeScannerIcon from "@mui/icons-material/QrCodeScanner";
import ViewSidebarIcon from "@mui/icons-material/ViewSidebar";

import { IIssuance, ISortState } from "../../../../shared/@core";
import { get, patch, post, errorMessage } from "../../utils/service";
import { formatDateTime } from "../../utils/format";
import { BoardFilters, initialFilters, toQuery } from "../components/BoardFilters";
import { IssuancesTable, PAGE_SIZE, RowAction, canSelect } from "../components/IssuancesTable";
import { SideWidgets } from "../components/SideWidgets";
import { AssignCourierDialog } from "../components/AssignCourierDialog";
import { IssuanceDetailDialog } from "../components/IssuanceDetailDialog";
import { FindNumberDialog } from "../../components/FindNumberDialog";

//the side panel's open / hidden choice outlives the page (spec 4.1 "סגור פאנל"). storage can be off in a private window,
//then the choice lasts the session only
const SIDE_PANEL_KEY = "es_board_side";

function readSidePanel() {
  try {
    return localStorage.getItem(SIDE_PANEL_KEY) !== "hidden";
  } catch {
    return true;
  }
}

//לוח ניהול הנפקות - the manager home. table + filters + the two side widgets + a bottom bar for bulk actions
export default function IssuancesBoard() {
  const { t } = useTranslation();

  const [filters, setFilters] = useState<any>(initialFilters); //today's date on first open, the lists empty
  const [sideOpen, setSideOpen] = useState(readSidePanel);
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
      const params = { ...toQuery(filters), sort: sort?.key, order: sort?.dir, page, page_size: PAGE_SIZE };
      const [res, c, s] = await Promise.all([get("/issuances", params), get("/couriers"), get("/issuances/summary")]);
      // console.log("board data", res);
      setData(res);
      setCouriers(c);
      setSummary(s);
      setUpdatedAt(new Date());
      //a page that outlived its rows (the last row of the last page deleted or moved to self pickup): back to the last
      //page that has any. the grid does this on its own on desktop, the cards need it here
      const lastPage = Math.max(Math.ceil(res.total / PAGE_SIZE), 1);
      if (page > lastPage) setPage(lastPage);
      //rows that left the page (filter change, status change) leave the selection too, and so does a row whose new
      //status the bar actions may not touch any more (a courier delivered part of it meanwhile)
      setSelected((ids) => ids.filter((id) => res.rows.some((r) => r.id === id && canSelect(r))));
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

  //only the panel moves: filters, page, sort and the selection are state of their own and stay where they are
  function toggleSidePanel(open: boolean) {
    setSideOpen(open);
    try {
      localStorage.setItem(SIDE_PANEL_KEY, open ? "open" : "hidden");
    } catch {
      //no storage, no memory of the choice
    }
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //a refused action: the toast says why, and a 409 means the row on screen is behind the server (another manager or a
  //courier moved it), so the board reloads and the kebab stops offering what is gone
  function failed(e: any) {
    setToast({ text: errorMessage(e), severity: "error" });
    if (e?.response?.status === 409) load();
  }

  async function markUrgent(ids: number[]) {
    try {
      await post("/issuances/mark-urgent", { ids });
      setSelected([]);
      load();
    } catch (e) {
      failed(e);
    }
  }

  async function selfPickup(id: number) {
    try {
      await patch(`/issuances/${id}`, { self_pickup: true });
      setToast({ text: t("self_pickup_done"), severity: "success" });
      load();
    } catch (e) {
      failed(e);
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

  return (
    <div className={`board ${sideOpen ? "" : "board--no-side"}`}>
      <div className="board__main">
        <div className="board__title-row">
          <div>
            <h1>{t("board_title")}</h1>
            <div className="board__updated">{updatedAt ? t("board_updated_at", { time: formatDateTime(updatedAt) }) : t("loading")}</div>
          </div>
          <div className="board__title-actions">
            {!sideOpen && (
              <Button variant="outlined" startIcon={<ViewSidebarIcon />} onClick={() => toggleSidePanel(true)}>
                {t("side_panel_show")}
              </Button>
            )}
            <Button variant="contained" className="board__find" startIcon={<QrCodeScannerIcon />} onClick={() => setFinding(true)}>
              {t("find_issuance")}
            </Button>
          </div>
        </div>

        <BoardFilters filters={filters} cities={summary.cities} onChange={changeFilters} />

        {/* the range and the page arrows live in the table now: the grid footer on desktop, a bar above the cards on a phone.
            the key remounts it when the panel goes or comes back: the grid flexes its columns against the width it measured
            at mount and keeps them when its box shrinks (a window resize re-flexes a wider box only), so a fresh mount is
            the one way the freed or taken column reaches the headers. a width the manager dragged is lost with it, like on
            any page change; page, sort and the selection are the board's and stay */}
        <IssuancesTable
          key={sideOpen ? "with-side" : "full-width"}
          rows={data.rows}
          total={data.total}
          page={page}
          loading={loading}
          selected={selected}
          onSelect={setSelected}
          onPage={setPage}
          sort={sort}
          onSort={changeSort}
          onOpen={(row) => setDetailId(row.id)}
          onAction={onRowAction}
        />
      </div>

      {sideOpen && <SideWidgets couriers={couriers} byCity={summary.by_city} onHide={() => toggleSidePanel(false)} />}

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
        onConflict={load}
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
