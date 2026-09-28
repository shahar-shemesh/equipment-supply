import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox, IconButton, ListItemIcon, Menu, MenuItem } from "@mui/material";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import PersonIcon from "@mui/icons-material/Person";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import LocalShippingIcon from "@mui/icons-material/LocalShipping";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";

import { IIssuance, IssuanceStatus } from "../../../../shared/@core";
import { PriorityBadge, StatusBadge } from "../../components/StatusBadge";
import { displayNumber, fullAddress } from "../../utils/format";
import { useBreakpoint } from "../../utils/useBreakpoint";
import { IssuanceCard } from "./IssuanceCard";

export type RowAction = "change_date" | "self_pickup" | "mark_urgent" | "change_courier" | "delete";

type Props = {
  rows: IIssuance[];
  loading: boolean;
  selected: number[];
  onSelect: (ids: number[]) => void;
  onOpen: (row: IIssuance) => void;
  onAction: (action: RowAction, row: IIssuance) => void;
};

//plain table on purpose, the design is a simple grid and a data-grid lib would fight the rtl styling.
//under 900px (phone and portrait tablet, where nine columns cannot fit) the same rows render as cards (IssuanceCard),
//the selection and the kebab menu are shared
export function IssuancesTable({ rows, loading, selected, onSelect, onOpen, onAction }: Props) {
  const { t } = useTranslation();
  const { compact } = useBreakpoint();
  const [menu, setMenu] = useState<{ anchor: HTMLElement; row: IIssuance }>(null);

  //rotating across the 900 line swaps the tree, the kebab the menu was anchored to is gone with it
  useEffect(() => {
    setMenu(null);
  }, [compact]);

  //closed issuances cannot be selected for assignment
  const selectable = rows.filter((r) => r.status === IssuanceStatus.unassigned || r.status === IssuanceStatus.assigned || r.status === IssuanceStatus.not_delivered || r.status === IssuanceStatus.partially_delivered);
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

  //one menu for the table rows and the cards, anchored to whichever kebab was tapped
  const actionsMenu = (
    <Menu open={!!menu} anchorEl={menu?.anchor} onClose={() => setMenu(null)}>
      <MenuItem onClick={() => act("change_date")}><ListItemIcon><CalendarMonthIcon fontSize="small" /></ListItemIcon>{t("row_change_date")}</MenuItem>
      <MenuItem onClick={() => act("self_pickup")}><ListItemIcon><PersonIcon fontSize="small" /></ListItemIcon>{t("row_self_pickup")}</MenuItem>
      <MenuItem onClick={() => act("mark_urgent")}><ListItemIcon><ErrorOutlineIcon fontSize="small" /></ListItemIcon>{t("mark_urgent")}</MenuItem>
      <MenuItem onClick={() => act("change_courier")}><ListItemIcon><LocalShippingIcon fontSize="small" /></ListItemIcon>{t("row_change_courier")}</MenuItem>
      <MenuItem onClick={() => act("delete")} className="menu-item--danger"><ListItemIcon><DeleteOutlineIcon fontSize="small" color="error" /></ListItemIcon>{t("row_delete")}</MenuItem>
    </Menu>
  );

  if (compact) {
    return (
      <div className={`issuance-cards ${loading ? "issuance-cards--loading" : ""}`}>
        <label className="issuance-cards__select-all">
          <Checkbox size="small" checked={allChecked} onChange={toggleAll} />
          {t("select_all")}
        </label>

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
    );
  }

  return (
    <div className={`issuances-table ${loading ? "issuances-table--loading" : ""}`}>
      <table>
        <thead>
          <tr>
            <th className="col-check"><Checkbox size="small" checked={allChecked} onChange={toggleAll} /></th>
            <th>{t("col_number")}</th>
            <th>{t("col_customer")}</th>
            <th>{t("col_destination")}</th>
            <th>{t("col_city")}</th>
            <th>{t("col_courier")}</th>
            <th>{t("col_priority")}</th>
            <th>{t("col_status")}</th>
            <th className="col-menu"></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !loading && (
            <tr><td colSpan={9} className="issuances-table__empty">{t("board_empty")}</td></tr>
          )}
          {rows.map((row) => {
            const canSelect = selectable.includes(row);
            return (
              <tr key={row.id} className={selected.includes(row.id) ? "is-selected" : ""}>
                <td className="col-check">
                  <Checkbox size="small" checked={selected.includes(row.id)} disabled={!canSelect} onChange={() => toggle(row.id)} />
                </td>
                <td>
                  <button type="button" className="link-button issuances-table__number" onClick={() => onOpen(row)}>{displayNumber(row)}</button>
                </td>
                <td className="col-wrap">{row.customer_name}</td>
                <td className="col-wrap">{fullAddress(row)}</td>
                <td>{row.address_city}</td>
                <td>{row.current_task?.courier?.name || <span className="muted">{t("detail_no_courier")}</span>}</td>
                <td><PriorityBadge priority={row.priority} /></td>
                <td><StatusBadge status={row.status} managerView /></td>
                <td className="col-menu">
                  <IconButton size="small" onClick={(e) => setMenu({ anchor: e.currentTarget, row })}><MoreVertIcon /></IconButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {actionsMenu}
    </div>
  );
}
