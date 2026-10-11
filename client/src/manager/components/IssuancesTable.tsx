import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox, IconButton, ListItemIcon, Menu, MenuItem, TextField } from "@mui/material";
import { DataGridPremium, GridColDef, GridLocaleText, GridPaginationModel, GridRowParams, GridRowSelectionModel, GridSortModel } from "@mui/x-data-grid-premium";
import { heIL } from "@mui/x-data-grid-premium/locales";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import PersonIcon from "@mui/icons-material/Person";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import LocalShippingIcon from "@mui/icons-material/LocalShipping";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import UnfoldMoreIcon from "@mui/icons-material/UnfoldMore";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";

import { IIssuance, ISortState, IssuanceSortKey, issuanceSortKeys } from "../../../../shared/@core";
import { IssuanceAction, canDo } from "../../../../shared/@rules";
import { statusKeys } from "../../../../shared/@utils";
import { PriorityBadge, StatusBadge } from "../../components/StatusBadge";
import { displayNumber, fullAddress } from "../../utils/format";
import { useBreakpoint } from "../../utils/useBreakpoint";
import { IssuanceCard } from "./IssuanceCard";

export const PAGE_SIZE = 15; //the design shows 15 rows a page

export type RowAction = "change_date" | "self_pickup" | "mark_urgent" | "change_courier" | "delete";

type Props = {
  rows: IIssuance[];
  total: number;
  page: number;
  loading: boolean;
  selected: number[];
  onSelect: (ids: number[]) => void;
  onPage: (page: number) => void;
  sort: ISortState; //null = the server default
  onSort: (next: ISortState) => void;
  onOpen: (row: IIssuance) => void;
  onAction: (action: RowAction, row: IIssuance) => void;
};

//the header text of every sortable column, by the key the server understands
const columnKeys: Record<IssuanceSortKey, string> = {
  number: "col_number",
  customer: "col_customer",
  destination: "col_destination",
  city: "col_city",
  courier: "col_courier",
  priority: "col_priority",
  status: "col_status",
};

//what the server checks behind every kebab item (shared/@rules.ts), so a row only offers what it would accept
const actionRules: Record<RowAction, IssuanceAction> = {
  change_date: "edit",
  self_pickup: "self_pickup",
  mark_urgent: "edit",
  change_courier: "assign",
  delete: "delete",
};

//the bottom bar has two actions, assign and mark urgent. a row joins the selection only when the server takes both:
//assign is all or nothing (one refused row fails the batch with a 409), mark urgent skips what it may not touch, and
//neither should happen from a checkbox. partially_delivered is frozen on the server and stays out of the selection
export function canSelect(row: IIssuance) {
  return canDo("assign", row.status) && canDo("edit", row.status);
}

function rowSelectable(p: GridRowParams<IIssuance>) {
  return canSelect(p.row);
}

//the grid's own idle glyph previews the next direction (an up arrow), the design has the faint up/down pair on every
//idle column. sortingOrder is the slot's prop, an svg has no use for it
function UnsortedIcon({ sortingOrder, ...rest }: any) {
  return <UnfoldMoreIcon {...rest} />;
}

//the v8 model is { type, ids }. the header checkbox only produces "exclude" when isRowSelectable is not set, so it
//never happens here; still both shapes become the concrete ids of this page's selectable rows before the bulk actions see them
export function selectionToIds(model: GridRowSelectionModel, selectable: number[]) {
  return selectable.filter((id) => (model.type === "include" ? model.ids.has(id) : !model.ids.has(id)));
}

//one entry or none. the grid walks asc -> desc -> default on its own (its default sortingOrder), like the old header did
export function sortModelToState(model: GridSortModel): ISortState {
  return model.length ? { key: model[0].field as IssuanceSortKey, dir: model[0].sort === "desc" ? "desc" : "asc" } : null;
}

/*──────────────────────────────────────────────────────────────────────────*/

//mui data grid premium in server mode on desktop: it never holds more than the page the api returned, a page or a header
//click goes up to IssuancesBoard, which owns page / sort / selected and runs the request. under 900px (phone and portrait
//tablet, where nine columns cannot fit) the same rows render as cards (IssuanceCard) with a select all, a sort select
//and the range arrows above them; the kebab menu is shared
export function IssuancesTable({ rows, total, page, loading, selected, onSelect, onPage, sort, onSort, onOpen, onAction }: Props) {
  const { t } = useTranslation();
  const { compact } = useBreakpoint();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; row: IIssuance }>(null);

  //rotating across the 900 line swaps the tree, the kebab the menu was anchored to is gone with it
  useEffect(() => {
    setMenu(null);
  }, [compact]);

  const selectable = rows.filter(canSelect);
  const allChecked = selectable.length > 0 && selectable.every((r) => selected.includes(r.id));

  function toggle(id: number) {
    onSelect(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  function toggleAll() {
    onSelect(allChecked ? [] : selectable.map((r) => r.id));
  }

  function act(action: RowAction) {
    const row = menu.row;
    setMenu(null);
    onAction(action, row);
  }

  function flipDir() {
    onSort({ key: sort.key, dir: sort.dir === "asc" ? "desc" : "asc" });
  }

  function changeSelection(model: GridRowSelectionModel) {
    onSelect(selectionToIds(model, selectable.map((r) => r.id)));
  }

  function changeSort(model: GridSortModel) {
    onSort(sortModelToState(model));
  }

  //the three models keep their reference between renders on purpose. the grid compares them by reference: a fresh [] for
  //"no sort" on every render reads as a sort change, and the grid answers a sort change by jumping back to page 1
  //(so page 2 bounced straight back). the columns too: a new array makes the grid re-register them and drop a width
  //the manager dragged, so onOpen is read through a ref instead of sitting in the memo deps
  const selectionModel = useMemo<GridRowSelectionModel>(() => ({ type: "include", ids: new Set(selected) }), [selected]);
  const sortModel = useMemo<GridSortModel>(() => (sort ? [{ field: sort.key, sort: sort.dir }] : []), [sort]);
  const paginationModel = useMemo<GridPaginationModel>(() => ({ page: page - 1, pageSize: PAGE_SIZE }), [page]);

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  //every column flexes between a floor and a cap. the floor is the header (title + sort button + padding) or the widest
  //value, whichever is wider, and the floors plus the checkbox and the kebab add up to 920px: what the grid gets at 1440,
  //where the widgets column takes the rest. the badge columns are capped so a wide screen does not stretch them, the free
  //text ones (customer, destination, courier, city) have no cap and take the surplus
  const columns = useMemo<GridColDef<IIssuance>[]>(() => [
    { field: "number", headerName: t(columnKeys.number), flex: 1, minWidth: 148, maxWidth: 180, renderCell: (p) => <button type="button" className="link-button issuances-grid__number" onClick={() => onOpenRef.current(p.row)}>{displayNumber(p.row)}</button> },
    { field: "customer", headerName: t(columnKeys.customer), flex: 1.2, minWidth: 100, cellClassName: "col-wrap", valueGetter: (_, row) => row.customer_name },
    { field: "destination", headerName: t(columnKeys.destination), flex: 2, minWidth: 130, cellClassName: "col-wrap", valueGetter: (_, row) => fullAddress(row) },
    { field: "city", headerName: t(columnKeys.city), flex: 0.9, minWidth: 96, cellClassName: "col-wrap", valueGetter: (_, row) => row.address_city },
    //the manager who handed a self pickup over at the warehouse stands where the courier would be
    { field: "courier", headerName: t(columnKeys.courier), flex: 1, minWidth: 100, cellClassName: "col-wrap", renderCell: (p) => p.row.current_task?.courier?.name || p.row.delivered_by_name || <span className="muted">{t("detail_no_courier")}</span> },
    { field: "priority", headerName: t(columnKeys.priority), flex: 0.7, minWidth: 104, maxWidth: 130, align: "center", headerAlign: "center", renderCell: (p) => <PriorityBadge priority={p.row.priority} /> },
    { field: "status", headerName: t(columnKeys.status), flex: 1, minWidth: 142, maxWidth: 190, align: "center", headerAlign: "center", renderCell: (p) => <StatusBadge status={p.row.status} managerView /> },
    //the kebab. not a sort key on the server, so no header click either. the button is the whole cell (col-tight)
    { field: "actions", headerName: "", width: 50, sortable: false, align: "center", headerAlign: "center", headerClassName: "col-tight", cellClassName: "col-tight", renderCell: (p) => <IconButton size="small" aria-label={t("row_actions")} onClick={(e) => setMenu({ anchor: e.currentTarget, row: p.row })}><MoreVertIcon /></IconButton> },
  ], [t]);

  //the grid's hebrew plus the board's own two strings: the empty text and the "1-15 מתוך N הנפקות" range in the footer
  const localeText = useMemo<Partial<GridLocaleText>>(() => ({
    ...heIL.components.MuiDataGrid.defaultProps.localeText,
    noRowsLabel: t("board_empty"),
    paginationDisplayedRows: ({ from, to, count }) => t("board_range", { from, to, total: count }),
  }), [t]);

  //one menu for the grid rows and the cards, anchored to whichever kebab was tapped. an item the server would refuse
  //for this row's status is disabled, not hidden, and a caption at the top says why the menu is short
  const allowed = (action: RowAction) => !menu || canDo(actionRules[action], menu.row.status);
  const blocked = !!menu && (Object.keys(actionRules) as RowAction[]).some((action) => !allowed(action));
  const actionsMenu = (
    <Menu open={!!menu} anchorEl={menu?.anchor} onClose={() => setMenu(null)}>
      {blocked && <MenuItem disabled className="menu-item--caption">{t("row_actions_blocked", { status: t(statusKeys[menu.row.status]) })}</MenuItem>}
      <MenuItem disabled={!allowed("change_date")} onClick={() => act("change_date")}><ListItemIcon><CalendarMonthIcon fontSize="small" /></ListItemIcon>{t("row_change_date")}</MenuItem>
      <MenuItem disabled={!allowed("self_pickup")} onClick={() => act("self_pickup")}><ListItemIcon><PersonIcon fontSize="small" /></ListItemIcon>{t("row_self_pickup")}</MenuItem>
      <MenuItem disabled={!allowed("mark_urgent")} onClick={() => act("mark_urgent")}><ListItemIcon><ErrorOutlineIcon fontSize="small" /></ListItemIcon>{t("mark_urgent")}</MenuItem>
      <MenuItem disabled={!allowed("change_courier")} onClick={() => act("change_courier")}><ListItemIcon><LocalShippingIcon fontSize="small" /></ListItemIcon>{t("row_change_courier")}</MenuItem>
      <MenuItem disabled={!allowed("delete")} onClick={() => act("delete")} className="menu-item--danger"><ListItemIcon><DeleteOutlineIcon fontSize="small" color="error" /></ListItemIcon>{t("row_delete")}</MenuItem>
    </Menu>
  );

  if (compact) {
    const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
    const to = Math.min(page * PAGE_SIZE, total);
    const lastPage = Math.max(Math.ceil(total / PAGE_SIZE), 1);

    return (
      <>
        {/* the cards have no footer, the range and its arrows stay above them as they were */}
        <div className="board__range">
          <span>{t("board_range", { from, to, total })}</span>
          <button type="button" className="board__page-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>{"›"}</button>
          <button type="button" className="board__page-btn" disabled={page >= lastPage} onClick={() => onPage(page + 1)}>{"‹"}</button>
        </div>

        <div className={`issuance-cards ${loading ? "issuance-cards--loading" : ""}`}>
          <div className="issuance-cards__toolbar">
            <label className="issuance-cards__select-all">
              <Checkbox size="small" checked={allChecked} onChange={toggleAll} />
              {t("select_all")}
            </label>

            {/* no headers to click on a phone, the same columns in a select plus one button for the direction */}
            <div className="issuance-cards__sort">
              <TextField select label={t("sort_by")} value={sort?.key || ""} onChange={(e) => onSort(e.target.value ? { key: e.target.value as IssuanceSortKey, dir: sort?.dir || "asc" } : null)}>
                <MenuItem value="">{t("sort_default")}</MenuItem>
                {issuanceSortKeys.map((k) => (
                  <MenuItem key={k} value={k}>{t(columnKeys[k])}</MenuItem>
                ))}
              </TextField>
              <IconButton aria-label={t("sort_toggle_dir")} disabled={!sort} onClick={flipDir}>
                {sort?.dir === "desc" ? <ArrowDownwardIcon /> : <ArrowUpwardIcon />}
              </IconButton>
            </div>
          </div>

          {rows.length === 0 && !loading && <div className="issuance-cards__empty">{t("board_empty")}</div>}
          {rows.map((row) => (
            <IssuanceCard
              key={row.id}
              row={row}
              checked={selected.includes(row.id)}
              canSelect={selectable.includes(row)}
              onToggle={() => toggle(row.id)}
              onOpen={() => onOpen(row)}
              onMenu={(anchor) => setMenu({ anchor, row })}
            />
          ))}

          {actionsMenu}
        </div>
      </>
    );
  }

  return (
    <>
      <DataGridPremium
        className="issuances-grid"
        rows={rows}
        columns={columns}
        loading={loading}
        autoHeight
        getRowHeight={() => "auto"}
        columnHeaderHeight={48}
        localeText={localeText}
        //server mode: page and sort are the board's state, the grid only draws them and reports the clicks.
        //pagination itself is opt in on the premium grid (the mit one always pages), without it the footer is a row count
        pagination
        paginationMode="server"
        rowCount={total}
        paginationModel={paginationModel}
        onPaginationModelChange={(m) => onPage(m.page + 1)}
        pageSizeOptions={[PAGE_SIZE]}
        sortingMode="server"
        sortModel={sortModel}
        onSortModelChange={changeSort}
        disableMultipleColumnsSorting
        //the filter bar above is the only filter. everything that only makes sense on the full set stays off,
        //the column menu too (it is the way into pinning, hiding and grouping)
        disableColumnFilter
        disableColumnMenu
        disableRowGrouping
        disableAggregation
        disablePivoting
        checkboxSelection
        disableRowSelectionOnClick
        isRowSelectable={rowSelectable}
        rowSelectionModel={selectionModel}
        onRowSelectionModelChange={changeSelection}
        hideFooterSelectedRowCount
        slots={{ columnUnsortedIcon: UnsortedIcon }}
        slotProps={{ baseCheckbox: { size: "small" } }}
      />

      {actionsMenu}
    </>
  );
}
