import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Button, CircularProgress, Dialog, DialogContent, IconButton, TextField } from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";

import { IDeliveryTask, IssuanceStatus, RecipientType, TaskStatus } from "../../../../shared/@core";
import { reasonKeys } from "../../../../shared/@utils";
import { StatusBadge } from "../../components/StatusBadge";
import { errorMessage, get, post } from "../../utils/service";
import { displayNumber, formatDateTime, fullAddress } from "../../utils/format";
import { ItemAnswer, ItemReportCard } from "../components/ItemReportCard";
import { SignaturePad } from "../components/SignaturePad";

//פרטי הנפקה - the courier's delivery screen. customer details, one report block per item, who received, signature, send.
//everything is plain state: the form is dynamic per item and small enough that react-hook-form would not buy much here
export default function TaskDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();

  const [task, setTask] = useState<IDeliveryTask>(null);
  const [pendingIds, setPendingIds] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, ItemAnswer>>({});
  const [recipientType, setRecipientType] = useState<RecipientType>(RecipientType.customer);
  const [recipient, setRecipient] = useState({ name: "", id_number: "", phone: "" });
  const [signature, setSignature] = useState("");
  const [errors, setErrors] = useState<Record<string, any>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setTask(null);
    setAnswers({});
    setErrors({});
    setError("");
    get(`/delivery/tasks/${id}`).then(setTask).catch((e) => setError(errorMessage(e)));
    //for the "הנפקה 1 מתוך 5" counter and the arrows, the open tasks in board order
    get("/delivery/tasks", { tab: "pending" }).then((r) => setPendingIds(r.rows.map((x) => x.id))).catch(() => setPendingIds([]));
  }, [id]);

  const position = pendingIds.indexOf(+id);
  const prevId = position > 0 ? pendingIds[position - 1] : null;
  const nextId = position >= 0 && position < pendingIds.length - 1 ? pendingIds[position + 1] : null;

  /*──────────────────────────────────────────────────────────────────────────*/

  function validate() {
    const next: Record<string, any> = {};
    for (const item of task.issuance.items) {
      const a = answers[item.id] || {};
      const itemErrors: any = {};
      if (a.delivered === undefined) itemErrors.delivered = t("required");
      if (a.delivered === false && !a.reason) itemErrors.reason = t("required");
      if (a.delivered === false && !(a.reason_details || "").trim()) itemErrors.reason_details = t("required");
      if (Object.keys(itemErrors).length) next[`item_${item.id}`] = itemErrors;
    }
    if (recipientType === RecipientType.other) {
      if (!recipient.name.trim()) next.recipient_name = t("required");
      if (!recipient.id_number.trim()) next.recipient_id_number = t("required");
      if (!recipient.phone.trim()) next.recipient_phone = t("required");
    }
    if (!signature) next.signature = t("signature_missing");
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit() {
    if (!validate()) {
      setError(t("form_incomplete"));
      return;
    }
    setError("");
    setBusy(true);
    try {
      await post(`/delivery/tasks/${id}/attempts`, {
        recipient_type: recipientType,
        recipient_name: recipient.name,
        recipient_id_number: recipient.id_number,
        recipient_phone: recipient.phone,
        signature_png: signature,
        items: task.issuance.items.map((item) => ({ item_id: item.id, ...answers[item.id] })),
      });
      setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  if (error && !task) return <Alert severity="error">{error}</Alert>;
  if (!task) return <div className="page-loading"><CircularProgress /></div>;

  const issuance = task.issuance;
  const lastAttempt = task.attempts?.slice(-1)[0];
  const closed = task.status !== TaskStatus.pending;

  return (
    <div className="task-detail">
      <Link to="/courier" className="task-detail__back"><ChevronLeftIcon fontSize="small" /> {t("back")}</Link>
      <h1>{t("task_title")}</h1>

      <div className="task-detail__nav">
        <IconButton disabled={!nextId} onClick={() => navigate(`/courier/tasks/${nextId}`)}><ArrowForwardIcon /></IconButton>
        <div>
          <div className="task-detail__number">{displayNumber(issuance)}</div>
          <StatusBadge status={closed ? issuance.status : IssuanceStatus.assigned} />
          {position >= 0 && <div className="muted small">{t("task_position", { n: position + 1, total: pendingIds.length })}</div>}
        </div>
        <IconButton disabled={!prevId} onClick={() => navigate(`/courier/tasks/${prevId}`)}><ArrowBackIcon /></IconButton>
      </div>

      <section className="task-section">
        <h2>{t("customer_details")}</h2>
        <div className="kv"><label>{t("customer_full_name")}</label><span>{issuance.customer_name}</span></div>
        <div className="kv"><label>{t("customer_id_number")}</label><span>{issuance.customer_id_number || "-"}</span></div>
        <div className="kv"><label>{t("customer_phone")}</label><span>{issuance.customer_phone || "-"}</span></div>
        <div className="kv"><label>{t("customer_address")}</label><span>{issuance.address_street}, {issuance.address_city}</span></div>
        <div className="kv"><label>{t("customer_building")}</label><span>{issuance.address_building || "-"}</span></div>
      </section>

      {closed && (
        <section className="task-section task-section--readonly">
          <Alert severity="info">{t("task_already_done")} {lastAttempt && `(${t("reported_at")}${formatDateTime(lastAttempt.reported_at)})`}</Alert>
          {lastAttempt && (
            <>
              <h2>{t("delivery_report")}</h2>
              {issuance.items.map((item) => {
                const r = lastAttempt.items?.find((x) => x.item_id === item.id);
                return (
                  <div key={item.id} className="kv">
                    <label>{item.product_name}</label>
                    <span>{r?.delivered ? t("item_delivered") : `${t("item_not_delivered")}${r?.reason ? ` - ${t(reasonKeys[r.reason])}` : ""}`}</span>
                  </div>
                );
              })}
              <div className="kv"><label>{t("recipient_section")}</label><span>{lastAttempt.recipient_name} {lastAttempt.recipient_phone ? `(${lastAttempt.recipient_phone})` : ""}</span></div>
              {lastAttempt.signature_png && (
                <div className="kv"><label>{t("signature")}</label><img className="signature-image" src={lastAttempt.signature_png} alt="" /></div>
              )}
            </>
          )}
        </section>
      )}

      {!closed && (
        <>
          <h2 className="task-detail__section-title">{t("delivery_report")}</h2>
          {issuance.items.map((item, idx) => (
            <ItemReportCard
              key={item.id}
              item={item}
              index={idx}
              answer={answers[item.id] || {}}
              errors={errors[`item_${item.id}`] || {}}
              onChange={(a) => setAnswers({ ...answers, [item.id]: a })}
            />
          ))}

          <h2 className="task-detail__section-title">{t("recipient_section")}</h2>
          <section className="task-section">
            <div className="item-report__question">{t("recipient_q")}</div>
            <div className="toggle-pair">
              <button type="button" className={recipientType === RecipientType.customer ? "is-active" : ""} onClick={() => setRecipientType(RecipientType.customer)}>{t("recipient_customer")}</button>
              <button type="button" className={recipientType === RecipientType.other ? "is-active" : ""} onClick={() => setRecipientType(RecipientType.other)}>{t("recipient_other")}</button>
            </div>

            {recipientType === RecipientType.other && (
              <div className="recipient-fields">
                <label>{t("recipient_name")}<span className="req">*</span></label>
                <TextField fullWidth value={recipient.name} error={!!errors.recipient_name} helperText={errors.recipient_name} onChange={(e) => setRecipient({ ...recipient, name: e.target.value })} />
                <label>{t("recipient_id_number")}<span className="req">*</span></label>
                <TextField fullWidth value={recipient.id_number} error={!!errors.recipient_id_number} helperText={errors.recipient_id_number} inputProps={{ inputMode: "numeric" }} onChange={(e) => setRecipient({ ...recipient, id_number: e.target.value })} />
                <label>{t("recipient_phone")}<span className="req">*</span></label>
                <TextField fullWidth value={recipient.phone} error={!!errors.recipient_phone} helperText={errors.recipient_phone} inputProps={{ inputMode: "tel" }} onChange={(e) => setRecipient({ ...recipient, phone: e.target.value })} />
              </div>
            )}
          </section>

          <SignaturePad onChange={setSignature} error={errors.signature} />

          {error && <Alert severity="error">{error}</Alert>}

          <Button variant="contained" size="large" fullWidth className="task-detail__submit" disabled={busy} onClick={submit}>
            {busy ? <CircularProgress size={20} color="inherit" /> : t("submit")}
          </Button>
        </>
      )}

      <Dialog open={done} maxWidth="xs" fullWidth>
        <DialogContent className="success-dialog">
          <CheckCircleIcon className="success-dialog__icon" />
          <h2>{t("submit_done")}</h2>
          <Button variant="contained" onClick={() => navigate("/courier")}>{t("back_home")}</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
