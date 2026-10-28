import { memo, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@mui/material";
import { DataGridPremium, GridColDef, GridLocaleText, GridPaginationModel, GridSortDirection, GridSortModel } from "@mui/x-data-grid-premium";
import { heIL } from "@mui/x-data-grid-premium/locales";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";

import { IAuditEntry } from "../../../../shared/@core";
import { actionLabel, actorLabel, entityIdLabel, entityTypeLabel, summary } from "../../utils/auditFormat";
import { formatDateTime } from "../../utils/format";
import { useBreakpoint } from "../../utils/useBreakpoint";

export const AUDIT_PAGE_SIZE = 25;

//the one sort the server has: the timeline, newest or oldest first (the order parameter of GET /api/audit)
export type AuditOrder = "asc" | "desc";

type Props = {
  rows: IAuditEntry[];
  total: number;
  page: number;
  loading: boolean;
  order: AuditOrder;
  onPage: (page: number) => void;
  onOrder: (next: AuditOrder) => void;
  onOpen: (row: IAuditEntry) => void;
};

//the grid's sort model to the server's order. the model never empties here (sortingOrder has no null), an empty one
//reads as the default all the same
export function orderFromModel(model: GridSortModel): AuditOrder {
  return model[0]?.sort === "asc" ? "asc" : "desc";
}

//module constants, not literals in the jsx: the virtualizer behind the grid keys its row metadata effect on the
//getRowHeight function, so a new one on every render made it walk the page and rewrite its store each time (with
//"auto" heights on top), and a new sortingOrder array re-registers the sort callbacks
const autoRowHeight = (): "auto" => "auto";
const pageSizeOptions = [AUDIT_PAGE_SIZE];
const sortingOrder: GridSortDirection[] = ["desc", "asc"];

/*──────────────────────────────────────────────────────────────────────────*/

//the board's grid (IssuancesTable.tsx) in its read only shape: server paging, the timestamp the only sortable column, a
//row click opens the drawer. under 900px the rows are cards with the range bar and an order toggle above them.
//memoized: the page renders again when the drawer opens and closes, and nothing here changes then
export const AuditTable = memo(function AuditTable({ rows, total, page, loading, order, onPage, onOrder, onOpen }: Props) {
  const { t } = useTranslation();
  const { compact } = useBreakpoint();

  //stable references, the grid compares its models by reference (see the note in IssuancesTable.tsx); onOpen is read
  //through a ref so the columns do not re-register on every render of the page
  const sortModel = useMemo<GridSortModel>(() => [{ field: "at", sort: order }], [order]);
  const paginationModel = useMemo<GridPaginationModel>(() => ({ page: page - 1, pageSize: AUDIT_PAGE_SIZE }), [page]);

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const columns = useMemo<GridColDef<IAuditEntry>[]>(() => [
    { field: "at", headerName: t("audit_col_at"), width: 150, valueGetter: (_, row) => formatDateTime(row.at) },
    { field: "actor", headerName: t("audit_col_actor"), flex: 1, minWidth: 120, sortable: false, cellClassName: "col-wrap", valueGetter: (_, row) => actorLabel(row, t) },
    { field: "action", headerName: t("audit_col_action"), flex: 1.1, minWidth: 150, sortable: false, cellClassName: "col-wrap", valueGetter: (_, row) => actionLabel(row.action, t) },
    //what the row is about, in two cells: the kind and the name or number the manager knows it by (the issuance number
    //also on a delivery or a rejected report, the courier's name on a courier row)
    { field: "entity_type", headerName: t("audit_col_entity"), flex: 0.8, minWidth: 110, sortable: false, valueGetter: (_, row) => entityTypeLabel(row.entity_type, t) },
    { field: "entity_ref", headerName: t("audit_col_entity_ref"), flex: 0.9, minWidth: 120, sortable: false, cellClassName: "col-wrap", valueGetter: (_, row) => entityIdLabel(row, t) || "-" },
    { field: "summary", headerName: t("audit_col_summary"), flex: 2.2, minWidth: 220, sortable: false, cellClassName: "col-wrap", valueGetter: (_, row) => summary(row, t) },
    //the open link, like the conflicts table; the whole row opens too (onRowClick)
    { field: "open", headerName: "", width: 70, sortable: false, align: "center", headerClassName: "col-tight", cellClassName: "col-tight", renderCell: (p) => <button type="button" className="link-button" onClick={() => onOpenRef.current(p.row)}>{t("audit_open_event")}</button> },
  ], [t]);

  const localeText = useMemo<Partial<GridLocaleText>>(() => ({
    ...heIL.components.MuiDataGrid.defaultProps.localeText,
    noRowsLabel: t("audit_empty"),
    paginationDisplayedRows: ({ from, to, count }) => t("audit_range", { from, to, total: count }),
  }), [t]);

  if (compact) {
    const from = total ? (page - 1) * AUDIT_PAGE_SIZE + 1 : 0;
    const to = Math.min(page * AUDIT_PAGE_SIZE, total);
    const lastPage = Math.max(Math.ceil(total / AUDIT_PAGE_SIZE), 1);

    return (
      <>
        <div className="board__range">
          <span>{t("audit_range", { from, to, total })}</span>
          <button type="button" className="board__page-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>{"›"}</button>
          <button type="button" className="board__page-btn" disabled={page >= lastPage} onClick={() => onPage(page + 1)}>{"‹"}</button>
          {/* no header to click on a phone: one button flips the timeline */}
          <Button variant="text" size="small" className="audit-cards__order" startIcon={order === "desc" ? <ArrowDownwardIcon /> : <ArrowUpwardIcon />} onClick={() => onOrder(order === "desc" ? "asc" : "desc")}>
            {t(order === "desc" ? "audit_sort_newest" : "audit_sort_oldest")}
          </Button>
        </div>

        <div className={`audit-cards ${loading ? "audit-cards--loading" : ""}`}>
          {rows.length === 0 && !loading && <div className="audit-cards__empty">{t("audit_empty")}</div>}
          {rows.map((row) => (
            <button type="button" key={row.id} className="audit-card" onClick={() => onOpen(row)}>
              <div className="audit-card__row audit-card__row--head">
                <strong>{actionLabel(row.action, t)}</strong>
                <span className="muted">{formatDateTime(row.at)}</span>
              </div>
              <div className="audit-card__row">
                <span><label>{t("audit_col_actor")}</label>{actorLabel(row, t)}</span>
                {entityIdLabel(row, t) && <span><label>{entityTypeLabel(row.entity_type, t)}</label>{entityIdLabel(row, t)}</span>}
              </div>
              <div className="audit-card__summary">{summary(row, t)}</div>
            </button>
          ))}
        </div>
      </>
    );
  }

  return (
    <DataGridPremium
      className="issuances-grid audit-grid"
      rows={rows}
      columns={columns}
      loading={loading}
      autoHeight
      getRowHeight={autoRowHeight}
      columnHeaderHeight={48}
      localeText={localeText}
      pagination
      paginationMode="server"
      rowCount={total}
      paginationModel={paginationModel}
      onPaginationModelChange={(m) => onPage(m.page + 1)}
      pageSizeOptions={pageSizeOptions}
      sortingMode="server"
      sortModel={sortModel}
      onSortModelChange={(m) => onOrder(orderFromModel(m))}
      //desc <-> asc on the header, never "no sort": the server always orders the timeline
      sortingOrder={sortingOrder}
      disableMultipleColumnsSorting
      disableColumnFilter
      disableColumnMenu
      disableRowGrouping
      disableAggregation
      disablePivoting
      disableRowSelectionOnClick
      onRowClick={(p) => onOpenRef.current(p.row)}
      hideFooterSelectedRowCount
    />
  );
});
