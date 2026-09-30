import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, CircularProgress, Dialog, DialogContent, IconButton, TextField } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";

import { ConflictReviewStatus, IDeliveryAttemptItem, IssuanceStatus } from "../../../../shared/@core";
import { reasonKeys, statusKeys, taskStatusKeys } from "../../../../shared/@utils";
import { StatusBadge } from "../../components/StatusBadge";
import { errorMessage, get, post } from "../../utils/service";
import { displayNumber, formatDateTime } from "../../utils/format";

type Props = {
  id: number; //null closes the dialog
  onClose: () => void;
  onChanged: () => void;
};

const NOTE_MAX = 500; //REVIEW_NOTE_MAX on the server

//the outcome the rejected answers would have had, for the badge only. never applied anywhere
function outcomeOf(items: IDeliveryAttemptItem[]) {
  const delivered = items.filter((a) => a.delivered).length;
  if (delivered === items.length) return IssuanceStatus.delivered;
  if (delivered === 0) return IssuanceStatus.not_delivered;
  return IssuanceStatus.partially_delivered;
}

/*──────────────────────────────────────────────────────────────────────────*/

//one rejected report next to the server's state, then and now, and the review form. "סימון כנבדק" writes a note and the
//reviewer, nothing else: the delivery stays as the other device or the manager left it
export function ConflictDetailDialog({ id, onClose, onChanged }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null); //{ conflict, current } from GET /conflicts/:id
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [taken, setTaken] = useState(false); //another manager reviewed it first (409 review_conflict)

  useEffect(() => {
    setData(null);
    setError("");
    setNote("");
    setNoteError("");
    setDone(false);
    setTaken(false);
    if (id) get(`/conflicts/${id}`).then(setData).catch((e) => setError(errorMessage(e)));
  }, [id]);

  async function markReviewed() {
    if (!note.trim()) {
      setNoteError(t("conflict_review_note_required"));
      return;
    }
    setBusy(true);
    setNoteError("");
    try {
      //the version the screen loaded rides along, a stale one is a 409 with the review that got there first
      const updated = await post(`/conflicts/${id}/review`, { note: note.trim(), version: data.conflict.review_version });
      setData({ ...data, conflict: { ...data.conflict, ...updated } });
      setDone(true);
      onChanged();
    } catch (e) {
      const review = e?.response?.data?.review;
      if (e?.response?.status === 409 && review) {
        setData({ ...data, conflict: { ...data.conflict, ...review } });
        setTaken(true);
        onChanged();
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const c = data?.conflict;
  const cur = data?.current;

  return (
    <Dialog open={!!id} onClose={onClose} maxWidth="md" fullWidth className="detail-dialog conflict-dialog">
      <DialogContent>
        {!data && !error && <div className="detail-dialog__loading"><CircularProgress /></div>}
        {error && <Alert severity="error">{error}</Alert>}

        {c && (
          <>
            <div className="dialog-title-row">
              <h2>{t("conflict_detail_title", { number: c.issuance ? displayNumber(c.issuance) : c.issuance_id })}</h2>
              <IconButton onClick={onClose} aria-label={t("close")}><CloseIcon /></IconButton>
            </div>

            <div className="conflict-dialog__meta">
              <span>{t("conflict_courier")}: <strong>{c.courier?.name || "-"}</strong></span>
              <span>{t("col_conflict_reason")}: <strong>{t(`conflict_reason_${c.rejection_code}`)}</strong></span>
              {c.client_reported_at && <span className="muted">{t("conflict_client_time", { time: formatDateTime(c.client_reported_at) })}</span>}
              <span className="muted">{t("conflict_received_time", { time: formatDateTime(c.received_at) })}</span>
            </div>

            <Alert severity="warning" icon={false}>{t("conflict_not_applied_note")}</Alert>

            <section className="detail-dialog__section conflict-dialog__report">
              <h3>{t("conflict_rejected_report")}</h3>
              <div className="conflict-dialog__chips"><StatusBadge status={outcomeOf(c.items || [])} managerView /></div>
              {(c.items || []).map((a: IDeliveryAttemptItem) => {
                //the line names come from the issuance as it is now; a line that no longer exists shows its id
                const item = c.issuance?.items?.find((i) => i.id === a.item_id);
                return (
                  <div key={a.item_id} className="kv">
                    <label>{item ? item.product_name : `#${a.item_id}`}</label>
                    <span>{a.delivered ? t("item_delivered") : `${t("item_not_delivered")}${a.reason ? ` - ${t(reasonKeys[a.reason])}` : ""}${a.reason_details ? ` - ${a.reason_details}` : ""}`}</span>
                  </div>
                );
              })}
              <div className="kv"><label>{t("recipient_section")}</label><span>{c.recipient_name || "-"} {c.recipient_phone ? `(${c.recipient_phone})` : ""}</span></div>
              {c.recipient_id_number && <div className="kv"><label>{t("recipient_id_number")}</label><span>{c.recipient_id_number}</span></div>}
              {c.signature_png && <div className="kv"><label>{t("signature")}</label><img className="signature-image" src={c.signature_png} alt="" /></div>}
            </section>

            <div className="conflict-dialog__states">
              <section className="detail-dialog__section">
                <h3>{t("conflict_state_at_rejection")}</h3>
                <div className="kv"><label>{t("conflict_task_status")}</label><span>{t(taskStatusKeys[c.observed.task_status])}</span></div>
                <div className="kv"><label>{t("conflict_issuance_status")}</label><span><StatusBadge status={c.observed.issuance_status} managerView /></span></div>
                <div className="kv"><label>{t("conflict_revision")}</label><span>{c.observed.issuance_revision}</span></div>
                <div className="kv"><label>{t("conflict_submitted_revision")}</label><span>{c.submitted_revision ?? "-"}</span></div>
                <div className="kv"><label>{t("conflict_open_task")}</label><span>{c.observed.current_task_id ? `#${c.observed.current_task_id}` : t("conflict_none")}</span></div>
              </section>
              <section className="detail-dialog__section">
                <h3>{t("conflict_state_now")}</h3>
                <div className="kv"><label>{t("conflict_issuance_status")}</label><span>{cur?.issuance ? <StatusBadge status={cur.issuance.status} managerView /> : "-"}</span></div>
                <div className="kv"><label>{t("conflict_revision")}</label><span>{cur?.issuance?.revision ?? "-"}</span></div>
                <div className="kv">
                  <label>{t("conflict_tasks_history")}</label>
                  <span>{(cur?.tasks || []).map((tk) => `#${tk.id} ${tk.courier_name || ""} (${t(taskStatusKeys[tk.status])})`).join(", ") || t("conflict_none")}</span>
                </div>
                <div className="kv">
                  <label>{t("conflict_applied_attempt")}</label>
                  <span>{cur?.attempt ? `${t(statusKeys[cur.attempt.outcome])}, ${formatDateTime(cur.attempt.reported_at)}${cur.attempt.recipient_name ? `, ${cur.attempt.recipient_name}` : ""}` : t("conflict_no_attempt")}</span>
                </div>
              </section>
            </div>

            <section className="detail-dialog__section conflict-dialog__review">
              <h3>{t("col_review")}</h3>
              {c.review_status === ConflictReviewStatus.reviewed ? (
                <>
                  {taken && <Alert severity="info">{t("conflict_review_taken")}</Alert>}
                  {done && <Alert severity="success">{t("conflict_review_done")}</Alert>}
                  <div className="muted">{t("conflict_reviewed_by", { name: c.reviewed_by_name || "", time: formatDateTime(c.reviewed_at) })}</div>
                  <div className="conflict-dialog__note">{c.review_note}</div>
                </>
              ) : (
                <>
                  <label>{t("conflict_review_note")}<span className="req">*</span></label>
                  <TextField multiline minRows={3} fullWidth placeholder={t("conflict_review_note_placeholder")} value={note} error={!!noteError} helperText={noteError} inputProps={{ maxLength: NOTE_MAX }} onChange={(e) => setNote(e.target.value)} />
                  <div>
                    <Button variant="contained" disabled={busy} onClick={markReviewed}>{t("conflict_mark_reviewed")}</Button>
                  </div>
                </>
              )}
            </section>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
