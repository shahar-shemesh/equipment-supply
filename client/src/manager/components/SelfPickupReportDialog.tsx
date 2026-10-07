import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, CircularProgress, Dialog, DialogContent, IconButton, TextField } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";

import { IAttemptPayload, IDeliveryAttemptItem, IDeliveryTask, IIssuance, RecipientType } from "../../../../shared/@core";
import { ItemAnswer, ItemReportCard } from "../../courier/components/ItemReportCard";
import { SignaturePad } from "../../courier/components/SignaturePad";
import { nothingDelivered, validateReportForm } from "../../courier/offline/store";
import { errorMessage, post } from "../../utils/service";
import { displayNumber } from "../../utils/format";

type Props = {
  issuance: IIssuance | null; //null closes the dialog
  onClose: () => void;
  onChanged: () => void;
};

const EMPTY_RECIPIENT = { name: "", id_number: "", phone: "" };

//the handover at the warehouse: the courier's report form (the same item cards, recipient block and pad) sent by the
//manager to POST /issuances/:id/self-pickup/report. online only, no draft and no queue: a manager sits at a desk,
//the server answers right away or the error stays on the form
export function SelfPickupReportDialog({ issuance, onClose, onChanged }: Props) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<Record<number, ItemAnswer>>({});
  const [recipientType, setRecipientType] = useState<RecipientType>(RecipientType.customer);
  const [recipient, setRecipient] = useState(EMPTY_RECIPIENT);
  const [signature, setSignature] = useState("");
  const [errors, setErrors] = useState<Record<string, any>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  //a fresh form for every issuance this opens on
  useEffect(() => {
    setAnswers({});
    setRecipientType(RecipientType.customer);
    setRecipient(EMPTY_RECIPIENT);
    setSignature("");
    setErrors({});
    setError("");
    setBusy(false);
    setDone(false);
  }, [issuance?.id]);

  //the courier's validation reads the items through a task; the handover has no task yet, the issuance is enough
  const task = issuance ? ({ issuance } as IDeliveryTask) : null;
  //every line "not delivered": no one received, the recipient block and the pad leave the form, same as the courier screen
  const noHandover = !!task && nothingDelivered(task, answers);

  //the data layer validates with i18n keys, the fields show the words (the same walk as TaskDetailPage.translate)
  function translate(fields: Record<string, any>) {
    const out: Record<string, any> = {};
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      if (typeof v === "string") out[k] = t(v);
      else {
        out[k] = {};
        for (const f of Object.keys(v)) out[k][f] = t(v[f]);
      }
    }
    return out;
  }

  async function submit() {
    const fields = validateReportForm(task, { answers, recipient_type: recipientType, recipient, signature_png: signature });
    if (Object.keys(fields).length) {
      setErrors(translate(fields));
      setError(t("form_incomplete"));
      return;
    }
    setErrors({});
    setError("");
    //the payload the courier's store builds: nothing handed over means no recipient and no signature leave the screen.
    //validated above, so every line has its delivered flag (the cast says so to the compiler)
    const items = issuance.items.map((item) => ({ item_id: item.id, ...answers[item.id] })) as IDeliveryAttemptItem[];
    const payload: IAttemptPayload = noHandover
      ? { recipient_type: null, signature_png: null, items }
      : { recipient_type: recipientType, recipient_name: recipient.name, recipient_id_number: recipient.id_number, recipient_phone: recipient.phone, signature_png: signature, items };
    setBusy(true);
    try {
      await post(`/issuances/${issuance.id}/self-pickup/report`, payload);
      setDone(true);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
      //a 409 means the issuance moved meanwhile (handed over, assigned or deleted by someone else): the detail and the
      //board behind this form should show that state, not the one the form was opened on
      if (e?.response?.status === 409) onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!issuance} onClose={busy ? undefined : onClose} maxWidth="md" fullWidth className="handover-dialog">
      {done && (
        <DialogContent className="success-dialog">
          <CheckCircleIcon className="success-dialog__icon" />
          <h2>{t("self_pickup_report_done")}</h2>
          <Button variant="contained" onClick={onClose}>{t("back")}</Button>
        </DialogContent>
      )}

      {issuance && !done && (
        <DialogContent>
          <div className="dialog-title-row">
            <h2>{t("self_pickup_report_title", { number: displayNumber(issuance) })}</h2>
            <IconButton onClick={onClose} disabled={busy}><CloseIcon /></IconButton>
          </div>

          <div className="handover-dialog__form">
            <h3 className="handover-dialog__section-title">{t("delivery_report")}</h3>
            {issuance.items.map((item, idx) => (
              <ItemReportCard key={item.id} item={item} index={idx} answer={answers[item.id] || {}} errors={errors[`item_${item.id}`] || {}} onChange={(a) => setAnswers({ ...answers, [item.id]: a })} />
            ))}

            {noHandover && <Alert severity="info" icon={false}>{t("no_handover_form")}</Alert>}

            {!noHandover && (
              <>
                <h3 className="handover-dialog__section-title">{t("recipient_section")}</h3>
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

                {/* keyed by issuance so another row never inherits the strokes of the last one */}
                <SignaturePad key={issuance.id} onChange={(png) => setSignature(png)} error={errors.signature} />
              </>
            )}

            {error && <Alert severity="error">{error}</Alert>}

            <Button variant="contained" size="large" fullWidth className="handover-dialog__submit" disabled={busy} onClick={submit}>
              {busy ? <CircularProgress size={20} color="inherit" /> : t("submit")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
