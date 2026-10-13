import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, CircularProgress, Dialog, DialogContent, FormControlLabel, IconButton, Switch, TextField, Tooltip } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import EditIcon from "@mui/icons-material/Edit";
import PersonIcon from "@mui/icons-material/Person";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import HandshakeIcon from "@mui/icons-material/Handshake";

import { IIssuance, IIssuanceItem, Priority } from "../../../../shared/@core";
import { IssuanceAction, canDo } from "../../../../shared/@rules";
import { reasonKeys, statusKeys } from "../../../../shared/@utils";
import { StatusBadge } from "../../components/StatusBadge";
import { del, errorMessage, get, patch } from "../../utils/service";
import { displayNumber, fullAddress } from "../../utils/format";
import { SelfPickupReportDialog } from "./SelfPickupReportDialog";

type Props = {
  id: number; //null closes the dialog
  onClose: () => void;
  onChanged: () => void;
  onAssign: (id: number) => void;
};

//the manager's view of one issuance. the design iterations for this screen are still moving (see the designer notes in design/),
//this follows the modal version: header fields, alert for undelivered items, date / self pickup / delete, then the items
export function IssuanceDetailDialog({ id, onClose, onChanged, onAssign }: Props) {
  const { t } = useTranslation();
  const [issuance, setIssuance] = useState<IIssuance>(null);
  const [error, setError] = useState("");
  const [deleteStep, setDeleteStep] = useState<"none" | "reason" | "confirm" | "done">("none");
  const [deleteReason, setDeleteReason] = useState("");
  const [handover, setHandover] = useState(false); //the self pickup report form over this dialog
  const [removeTarget, setRemoveTarget] = useState<IIssuanceItem>(null); //the line whose removal waits for the confirm step
  const [removing, setRemoving] = useState(false);
  const [removed, setRemoved] = useState(""); //the product name of the last line taken off, for the success alert

  async function load() {
    try {
      setIssuance(await get(`/issuances/${id}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  useEffect(() => {
    setIssuance(null);
    setError("");
    setDeleteStep("none");
    setDeleteReason("");
    setHandover(false);
    setRemoveTarget(null);
    setRemoving(false);
    setRemoved("");
    if (id) load();
  }, [id]);

  //a 409 means the issuance moved on the server while this dialog was open: show why, then reload it so the controls
  //follow the status it really has
  function failed(e: any) {
    setError(errorMessage(e));
    if (e?.response?.status === 409) {
      load();
      onChanged();
    }
  }

  async function update(body: any) {
    try {
      setIssuance(await patch(`/issuances/${id}`, body));
      onChanged();
    } catch (e) {
      failed(e);
    }
  }

  async function remove() {
    try {
      await del(`/issuances/${id}`, { reason: deleteReason });
      setDeleteStep("done");
      onChanged();
    } catch (e) {
      failed(e);
    }
  }

  //one line off the issuance. the server answers the whole issuance, so the line leaves the list without a reload; a
  //404 means it went meanwhile (another manager), so the dialog reloads like it does after a 409
  async function removeItem() {
    const target = removeTarget;
    setRemoving(true);
    try {
      setIssuance(await del(`/issuances/${id}/items/${target.id}`));
      setError("");
      setRemoved(target.product_name);
      onChanged();
    } catch (e) {
      setRemoved(""); //the success line of an earlier removal does not belong next to this error
      failed(e);
      if (e?.response?.status === 404) {
        load();
        onChanged();
      }
    } finally {
      setRemoving(false);
      setRemoveTarget(null);
    }
  }

  //the last attempt's undelivered lines, shown as the red alert at the top. a line the manager took off since is skipped:
  //the attempt still names its id, the issuance no longer has it
  const lastAttempt = issuance?.current_task?.attempts?.slice(-1)[0];
  const failedItems = (lastAttempt?.items || []).filter((x) => !x.delivered).map((x) => ({ ...x, item: issuance.items.find((i) => i.id === x.item_id) })).filter((x) => x.item);
  //the same table the server checks (shared/@rules.ts), action by action: self_pickup still takes a courier, a date or a
  //delete, delivered / partially_delivered / deleted take nothing and say so instead of a 409
  const can = (action: IssuanceAction) => !!issuance && canDo(action, issuance.status);
  const locked = !!issuance && !can("edit") && !can("assign") && !can("delete") && !can("self_pickup_report");

  return (
    <Dialog open={!!id} onClose={onClose} maxWidth="md" fullWidth className="detail-dialog">
      <DialogContent>
        {!issuance && !error && <div className="detail-dialog__loading"><CircularProgress /></div>}
        {error && <Alert severity="error">{error}</Alert>}

        {deleteStep === "done" && (
          <div className="success-dialog">
            <CheckCircleIcon className="success-dialog__icon" />
            <h2>{t("delete_done")}</h2>
            <Button variant="contained" onClick={onClose}>{t("back_to_board")}</Button>
          </div>
        )}

        {issuance && deleteStep !== "done" && (
          <>
            <div className="dialog-title-row">
              <h2>{t("detail_title", { number: displayNumber(issuance) })}</h2>
              <IconButton onClick={onClose}><CloseIcon /></IconButton>
            </div>

            <FormControlLabel
              control={<Switch checked={issuance.priority === Priority.urgent} disabled={!can("edit")} onChange={(e) => update({ priority: e.target.checked ? Priority.urgent : Priority.normal })} />}
              label={t("detail_mark_urgent")}
            />

            <section className="detail-dialog__section detail-dialog__head">
              <div className="field">
                <label>{t("detail_customer")}</label>
                <strong>{issuance.customer_name}</strong>
              </div>
              <div className="field">
                <label>{t("detail_destination")}</label>
                <strong>{fullAddress(issuance)}</strong>
              </div>
              <div className="field">
                <label>{t("detail_city")}</label>
                <strong>{issuance.address_city}</strong>
              </div>
              <div className="field">
                <label>{t("detail_courier")}</label>
                {/* a self pickup handed over at the warehouse has no courier, the manager who did it stands there */}
                <strong>{issuance.current_task?.courier?.name || issuance.delivered_by_name || t("detail_no_courier")}</strong>
                {can("assign") && (
                  <button type="button" className="link-button with-icon" onClick={() => onAssign(issuance.id)}>
                    <EditIcon fontSize="inherit" /> {t("change_courier")}
                  </button>
                )}
              </div>
              <div className="field">
                <label>{t("detail_status")}</label>
                <StatusBadge status={issuance.status} managerView />
              </div>

              {failedItems.length > 0 && (
                <div className="detail-dialog__alert">
                  {failedItems.map((f) => (
                    <div key={f.id}>
                      <ErrorIcon fontSize="small" /> <strong>{t("detail_item_not_delivered", { name: f.item?.product_name })}</strong>
                      <div className="muted">"{t(reasonKeys[f.reason])}{f.reason_details ? ` - ${f.reason_details}` : ""}"</div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {locked && <Alert severity="info" className="detail-dialog__locked">{t("detail_status_locked", { status: t(statusKeys[issuance.status]) })}</Alert>}

            <section className="detail-dialog__section detail-dialog__actions">
              <div className="field">
                <label><CalendarMonthIcon fontSize="inherit" /> {t("detail_delivery_date")}</label>
                <TextField type="date" value={issuance.delivery_date || ""} disabled={!can("edit")} onChange={(e) => update({ delivery_date: e.target.value })} />
              </div>
              {can("self_pickup") && (
                <Button variant="outlined" startIcon={<PersonIcon />} onClick={() => update({ self_pickup: true })}>
                  {t("row_self_pickup")}
                </Button>
              )}
              {can("self_pickup_report") && (
                <Button variant="contained" startIcon={<HandshakeIcon />} onClick={() => setHandover(true)}>
                  {t("self_pickup_report")}
                </Button>
              )}
              {can("delete") && deleteStep === "none" && (
                <Button color="error" startIcon={<DeleteOutlineIcon />} onClick={() => setDeleteStep("reason")}>
                  {t("row_delete")}
                </Button>
              )}
            </section>

            {deleteStep === "reason" && (
              <section className="detail-dialog__section detail-dialog__delete">
                <label>{t("detail_delete_reason")}</label>
                <TextField multiline minRows={3} fullWidth placeholder={t("detail_delete_placeholder")} value={deleteReason} onChange={(e) => setDeleteReason(e.target.value)} />
                <div className="detail-dialog__delete-actions">
                  <Button variant="contained" color="primary" startIcon={<DeleteOutlineIcon />} onClick={() => setDeleteStep("confirm")}>{t("row_delete")}</Button>
                  <Button variant="text" onClick={() => setDeleteStep("none")}>{t("cancel")}</Button>
                </div>
              </section>
            )}

            {removed && <Alert severity="success" className="detail-dialog__removed">{t("item_removed", { name: removed })}</Alert>}

            <section className="detail-dialog__section detail-dialog__items">
              {issuance.items.map((item) => (
                <div key={item.id} className={`item-lines${can("remove_item") ? " item-lines--removable" : ""}`}>
                  <div><label>{t("item_name")}</label><strong>{item.product_name}</strong></div>
                  <div><label>{t("item_station")}</label><strong>{item.station_number || "-"}</strong></div>
                  <div><label>{t("item_serial")}</label><strong>{item.serial_number || "-"}</strong></div>
                  <div><label>{t("item_catalog")}</label><strong>{item.catalog_number || "-"}</strong></div>
                  <div><label>{t("item_quantity")}</label><strong>{item.quantity} {t("item_unit")}</strong></div>
                  {/* the only line left cannot go (the server refuses it too): the icon stays, disabled, and the tooltip says why.
                      a disabled button fires no events, so the tooltip hangs on the span around it */}
                  {can("remove_item") && (
                    <Tooltip title={issuance.items.length === 1 ? t("item_remove_last", { number: displayNumber(issuance) }) : t("item_remove")}>
                      <span className="item-lines__remove">
                        <IconButton aria-label={t("item_remove")} disabled={issuance.items.length === 1} onClick={() => setRemoveTarget(item)}>
                          <DeleteOutlineIcon />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                </div>
              ))}
            </section>
          </>
        )}
      </DialogContent>

      {/* the handover form. the detail behind it reloads on success, so closing it shows the manager under שליח */}
      <SelfPickupReportDialog
        issuance={handover ? issuance : null}
        onClose={() => setHandover(false)}
        onChanged={() => {
          load();
          onChanged();
        }}
      />

      {/* second confirmation, the design shows it as its own modal */}
      <Dialog open={deleteStep === "confirm"} onClose={() => setDeleteStep("reason")} maxWidth="sm" fullWidth>
        <DialogContent className="confirm-dialog">
          <h2>{t("delete_confirm_title")}</h2>
          <p>{t("delete_confirm_text")}</p>
          <div className="confirm-dialog__actions">
            <Button variant="contained" onClick={remove}>{t("delete_confirm_button")}</Button>
            <Button variant="outlined" onClick={() => setDeleteStep("reason")}>{t("back")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* the confirm step of one line, named by its product. the request is in flight while the button shows the spinner
          (MUI 5.16 has no loading prop), and the dialog cannot be dismissed under it */}
      <Dialog open={!!removeTarget} onClose={() => !removing && setRemoveTarget(null)} maxWidth="sm" fullWidth>
        <DialogContent className="confirm-dialog">
          <h2>{t("item_remove_confirm_title")}</h2>
          <p>{t("item_remove_confirm_text", { name: removeTarget?.product_name })}</p>
          <div className="confirm-dialog__actions">
            <Button variant="contained" disabled={removing} startIcon={removing ? <CircularProgress size={16} color="inherit" /> : undefined} onClick={removeItem}>
              {t("item_remove_confirm_button")}
            </Button>
            <Button variant="outlined" disabled={removing} onClick={() => setRemoveTarget(null)}>{t("back")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
