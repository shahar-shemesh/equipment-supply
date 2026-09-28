import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Checkbox, Dialog, DialogContent, IconButton, InputAdornment, Snackbar, TextField } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";

import { ICourier } from "../../../../shared/@core";
import { del, errorMessage, get, post } from "../../utils/service";
import { formatDateTime } from "../../utils/format";
import { CourierDialog } from "../components/CourierDialog";

//לוח ניהול שליחים - the table from the design with add / edit / delete and a checkbox column for deleting several.
//the excel import from the spec (2.7.2) still has no screen
export default function CouriersPage() {
  const { t } = useTranslation();
  const [couriers, setCouriers] = useState<ICourier[]>([]);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [dialog, setDialog] = useState<{ open: boolean; courier: ICourier }>({ open: false, courier: null }); //courier = edit that row, null = add
  const [deleteIds, setDeleteIds] = useState<number[]>(null); //null = the confirm is closed
  const [toast, setToast] = useState<{ text: string; severity: "success" | "error" }>(null);

  async function load() {
    setLoading(true);
    try {
      const rows: ICourier[] = await get("/couriers");
      setCouriers(rows);
      setUpdatedAt(new Date());
      setSelected((ids) => ids.filter((id) => rows.some((r) => r.id === id)));
    } catch (e) {
      setToast({ text: errorMessage(e), severity: "error" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  //a few dozen rows at most, the search filters here and not on the server like the board does
  const visible = couriers.filter((c) => matches(c, q));
  const allChecked = visible.length > 0 && visible.every((c) => selected.includes(c.id));

  function toggleAll() {
    setSelected(allChecked ? [] : visible.map((c) => c.id));
  }

  function toggle(id: number) {
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  function closeDialog() {
    setDialog({ open: false, courier: null });
  }

  //an add stays in the dialog on its success screen (CourierDialog), an edit comes back here
  function onSaved(_: ICourier, mode: "add" | "edit") {
    load();
    if (mode === "edit") {
      closeDialog();
      setToast({ text: t("courier_updated"), severity: "success" });
    }
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  async function remove() {
    const ids = deleteIds;
    setDeleteIds(null);
    try {
      if (ids.length === 1) await del(`/couriers/${ids[0]}`);
      else await post("/couriers/remove", { ids });
      setSelected((s) => s.filter((id) => !ids.includes(id)));
      setToast({ text: ids.length === 1 ? t("courier_deleted") : t("couriers_deleted", { count: ids.length }), severity: "success" });
      load();
    } catch (e) {
      //the 409 names the couriers that still hold deliveries (busy), the hebrew around it is ours
      const busy = e?.response?.data?.busy;
      const text = Array.isArray(busy) ? t("courier_delete_busy", { names: busy.map((b) => `${b.name} (${b.count})`).join(", ") }) : errorMessage(e);
      setToast({ text, severity: "error" });
    }
  }

  return (
    <div className="couriers-page">
      <div className="couriers-page__title-row">
        <div>
          <h1>{t("couriers_title")}</h1>
          <div className="couriers-page__updated">{updatedAt ? t("board_updated_at", { time: formatDateTime(updatedAt) }) : t("loading")}</div>
        </div>
        <Button variant="contained" className="couriers-page__add" startIcon={<AddIcon />} onClick={() => setDialog({ open: true, courier: null })}>
          {t("courier_add")}
        </Button>
      </div>

      <div className="couriers-page__search">
        <TextField
          placeholder={t("couriers_search_placeholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          fullWidth
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
        />
      </div>

      {/* the board's table skin, three columns and the two icons. on a phone the rows become cards (scss) */}
      <div className={`issuances-table couriers-table ${loading ? "issuances-table--loading" : ""}`}>
        <table>
          <thead>
            <tr>
              <th className="col-check"><Checkbox size="small" checked={allChecked} onChange={toggleAll} /></th>
              <th>{t("courier_name")}</th>
              <th>{t("courier_phone")}</th>
              <th>{t("courier_id_number")}</th>
              <th className="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && !loading && (
              <tr><td colSpan={5} className="issuances-table__empty">{t("couriers_empty")}</td></tr>
            )}
            {visible.map((c) => (
              <tr key={c.id} className={selected.includes(c.id) ? "is-selected" : ""}>
                <td className="col-check"><Checkbox size="small" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} /></td>
                <td className="col-name">{c.name}</td>
                <td data-label={t("courier_phone")}>{c.phone || "-"}</td>
                <td data-label={t("courier_id_number")}>{c.id_number || "-"}</td>
                <td className="col-actions">
                  <IconButton size="small" aria-label={t("courier_edit")} onClick={() => setDialog({ open: true, courier: c })}><EditOutlinedIcon fontSize="small" /></IconButton>
                  <IconButton size="small" aria-label={t("courier_delete")} onClick={() => setDeleteIds([c.id])}><DeleteOutlineIcon fontSize="small" /></IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* the same sticky bar as the board, one action here */}
      {selected.length > 0 && (
        <div className="board__bottom-bar">
          <strong>{t("couriers_selected_count", { count: selected.length })}</strong>
          <Button variant="contained" startIcon={<DeleteOutlineIcon />} onClick={() => setDeleteIds(selected)}>{t("couriers_delete_selected")}</Button>
          <Button variant="text" onClick={() => setSelected([])}>{t("clear_selection")}</Button>
        </div>
      )}

      <CourierDialog open={dialog.open} courier={dialog.courier} onClose={closeDialog} onSaved={onSaved} />

      {/* "האם אתה בטוח שברצונך למחוק שליח זה?" - one modal for a row's trash icon and for the selection */}
      <Dialog open={!!deleteIds} onClose={() => setDeleteIds(null)} maxWidth="sm" fullWidth>
        <DialogContent className="confirm-dialog">
          <IconButton className="confirm-dialog__close" aria-label={t("close")} onClick={() => setDeleteIds(null)}><CloseIcon /></IconButton>
          <h2>{deleteIds?.length > 1 ? t("courier_delete_confirm_many", { count: deleteIds.length }) : t("courier_delete_confirm")}</h2>
          <div className="confirm-dialog__actions">
            <Button variant="contained" onClick={remove}>{t("courier_delete_yes")}</Button>
            <Button variant="outlined" onClick={() => setDeleteIds(null)}>{t("courier_delete_no")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast(null)} anchorOrigin={{ vertical: "top", horizontal: "center" }}>
        <Alert severity={toast?.severity || "info"} onClose={() => setToast(null)}>{toast?.text}</Alert>
      </Snackbar>
    </div>
  );
}

/*──────────────────────────────────────────────────────────────────────────*/

//name, phone or id. the phone is stored with a dash (052-4438192), so digits in the query are matched on digits only
function matches(c: ICourier, q: string) {
  const text = q.trim();
  if (!text) return true;
  if (c.name.includes(text)) return true;
  const digits = text.replace(/\D/g, "");
  return !!digits && [c.phone, c.id_number].some((v) => (v || "").replace(/\D/g, "").includes(digits));
}
