import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Button, CircularProgress, Dialog, DialogContent, IconButton, TextField } from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";

import { IssuanceStatus, RecipientType, ReportSyncState, TaskStatus } from "../../../../shared/@core";
import { reasonKeys } from "../../../../shared/@utils";
import { StatusBadge } from "../../components/StatusBadge";
import { useAuth } from "../../utils/auth";
import { displayNumber, formatDateTime } from "../../utils/format";
import { DraftRow, LocalReport, storageError } from "../offline/db";
import { scopeOf } from "../offline/identity";
import { deleteDraft, getDraft, getReport, isActiveState, putDraft, readPendingIds, submitReport, subscribe, validateReportForm } from "../offline/store";
import { getSyncStatus } from "../offline/sync";
import { useTask } from "../offline/useCourierData";
import { ItemAnswer, ItemReportCard } from "../components/ItemReportCard";
import { SignaturePad } from "../components/SignaturePad";
import { SyncChip } from "../components/SyncChip";
import { EvidenceLine } from "../components/EvidenceLine";
import { PendingReportsDialog } from "../components/PendingReportsDialog";

type Point = { x: number; y: number };

const AUTOSAVE_MS = 600;
const SYNC_WAIT_MS = 4000; //how long the send button waits for the server's word before saying "saved on the device"
const PENDING_STATES = [ReportSyncState.queued, ReportSyncState.syncing, ReportSyncState.auth];
const EMPTY_RECIPIENT = { name: "", id_number: "", phone: "" };

//פרטי הנפקה - the courier's delivery screen. customer details, one report block per item, who received, signature, send.
//everything is plain state: the form is dynamic per item and small enough that react-hook-form would not buy much here.
//the task comes from the device (useTask), the form is autosaved as a draft on the device, and send writes the report
//on the device first; the server hears about it from the sync worker, online and offline alike
export default function TaskDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const scope = scopeOf(user);
  const taskId = +id;

  const { data, loading, error: loadError } = useTask(scope, taskId);
  const task = data?.task ?? null;
  const [draft, setDraft] = useState<{ taskId: number; row: DraftRow | null } | null>(null);
  const [formTaskId, setFormTaskId] = useState<number | null>(null); //the task the form state below belongs to
  const [padKey, setPadKey] = useState(0); //bumped by ניקוי הטיוטה, the only way to empty a mounted pad
  const [pendingIds, setPendingIds] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, ItemAnswer>>({});
  const [recipientType, setRecipientType] = useState<RecipientType>(RecipientType.customer);
  const [recipient, setRecipient] = useState(EMPTY_RECIPIENT);
  const [signature, setSignature] = useState("");
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [errors, setErrors] = useState<Record<string, any>>({});
  const [error, setError] = useState("");
  const [rejected, setRejected] = useState<LocalReport | null>(null); //the report the server just refused, for the alert under the form
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"" | "synced" | "local">("");
  const [draftState, setDraftState] = useState<"" | "saving" | "saved" | "failed" | "restored">("");
  const [draftError, setDraftError] = useState("");
  const [hasDraft, setHasDraft] = useState(false);
  const [listOpen, setListOpen] = useState(false);

  //the autosave reads the form through this ref, never through a closure: a timer or a pagehide handler would
  //otherwise write whatever the form held when it was scheduled
  const formRef = useRef({ answers, recipientType, recipient, signature, strokes });
  formRef.current = { answers, recipientType, recipient, signature, strokes };
  //which task a scheduled save belongs to and whether send already happened, so a late timer never writes another
  //task's draft and never brings a draft back after submit
  const guard = useRef({ taskId: 0, submitted: false });
  const saveTimer = useRef<any>(null);
  const dirty = useRef(false);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setDraft(null);
    getDraft(scope, taskId)
      .then((row) => {
        if (!cancelled) setDraft({ taskId, row });
      })
      .catch(() => {
        if (!cancelled) setDraft({ taskId, row: null });
      });
    return () => {
      cancelled = true;
    };
  }, [scope, taskId]);

  //for the "הנפקה 1 מתוך 5" counter and the arrows, the open tasks in board order. `data` changes on every store event,
  //so a report sent from this page drops its task from the list right away
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    readPendingIds(scope)
      .then((ids) => {
        if (!cancelled) setPendingIds(ids);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [scope, data]);

  //the form is filled once per task, when both the task and its draft are here (the pad mounts with the draft's
  //strokes then). whatever the previous task still had unsaved goes out first
  useEffect(() => {
    if (!task || draft?.taskId !== taskId || formTaskId === taskId) return;
    flush();
    guard.current = { taskId, submitted: false };
    const row = draft.row;
    setAnswers(row?.answers || {});
    setRecipientType(row?.recipient_type || RecipientType.customer);
    setRecipient(row?.recipient || EMPTY_RECIPIENT);
    setSignature(row?.signature_png || "");
    setStrokes(row?.signature_strokes || []);
    setErrors({});
    setError("");
    setRejected(null);
    setDraftError("");
    setDraftState(row ? "restored" : "");
    setHasDraft(!!row);
    setFormTaskId(taskId);
  }, [task, draft, taskId, formTaskId]);

  useEffect(() => {
    if (draftState !== "restored") return;
    const timer = setTimeout(() => setDraftState((s) => (s === "restored" ? "" : s)), 3000);
    return () => clearTimeout(timer);
  }, [draftState]);

  //the debounce is not enough on a tablet that gets put in a pocket: the draft also goes out when the page is hidden
  //or unloaded, and when this screen is left
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [scope]);

  const position = pendingIds.indexOf(taskId);
  const prevId = position > 0 ? pendingIds[position - 1] : null;
  const nextId = position >= 0 && position < pendingIds.length - 1 ? pendingIds[position + 1] : null;

  /*──────────────────────────────────────────────────────────────────────────*/

  //every change of the form lands here: the draft is written 600ms after the last one
  function touch() {
    dirty.current = true;
    clearTimeout(saveTimer.current);
    const forTask = guard.current.taskId;
    saveTimer.current = setTimeout(() => saveDraft(forTask), AUTOSAVE_MS);
  }

  function flush() {
    if (!dirty.current) return;
    clearTimeout(saveTimer.current);
    saveDraft(guard.current.taskId);
  }

  async function saveDraft(forTask: number) {
    if (!scope || !forTask || guard.current.taskId !== forTask || guard.current.submitted) return;
    dirty.current = false;
    const f = formRef.current;
    setDraftState("saving");
    try {
      const r = await putDraft(scope, forTask, { answers: f.answers, recipient_type: f.recipientType, recipient: f.recipient, signature_png: f.signature, signature_strokes: f.strokes });
      if (guard.current.taskId !== forTask || dirty.current) return;
      //blocked: a report for this task is already queued, the draft stays gone on purpose
      setDraftState(r.blocked ? "" : "saved");
      if (!r.blocked) setHasDraft(true);
    } catch (e) {
      if (guard.current.taskId !== forTask) return;
      setDraftError(t(storageError(e)));
      setDraftState("failed");
    }
  }

  async function discardDraft() {
    clearTimeout(saveTimer.current);
    dirty.current = false;
    try {
      await deleteDraft(scope, taskId);
    } catch (e) {
      setDraftError(t(storageError(e)));
      setDraftState("failed");
      return;
    }
    setAnswers({});
    setRecipientType(RecipientType.customer);
    setRecipient(EMPTY_RECIPIENT);
    setSignature("");
    setStrokes([]);
    setErrors({});
    setDraftState("");
    setHasDraft(false);
    setPadKey((k) => k + 1);
  }

  function onSignature(png: string, s: Point[][]) {
    //the pad replays restored strokes when it mounts; at the same canvas size that is the png the draft already holds
    if (png === formRef.current.signature) return;
    setSignature(png);
    setStrokes(s);
    touch();
  }

  //the data layer validates with i18n keys, the fields show the words
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
    const form = { answers, recipient_type: recipientType, recipient, signature_png: signature };
    const fields = validateReportForm(task, form);
    if (Object.keys(fields).length) {
      setErrors(translate(fields));
      setError(t("form_incomplete"));
      return;
    }
    setErrors({});
    setError("");
    setRejected(null);
    setBusy(true);
    //from here on no draft write, whatever a timer still holds
    clearTimeout(saveTimer.current);
    dirty.current = false;
    guard.current.submitted = true;
    let report: LocalReport;
    try {
      report = await submitReport(scope, user, task, form);
    } catch (e) {
      guard.current.submitted = false;
      if (e?.fields) {
        setErrors(translate(e.fields));
        setError(t("form_incomplete"));
      } else if (e?.blocked) setError(t("sync_task_locked"));
      else setError(t(e?.storage || "local_save_failed"));
      setBusy(false);
      return;
    }
    setDraftState("");
    setHasDraft(false);
    //the report is on the device. with a network and a valid token the worker is already sending it: wait a little for
    //the server's word, and say "saved on the device" when it does not come in time. offline there is nothing to wait for
    if (!navigator.onLine || getSyncStatus().auth_required) {
      setBusy(false);
      setDone("local");
      return;
    }
    const final = await waitForResult(scope, report.operation_id, SYNC_WAIT_MS);
    setBusy(false);
    if (!final) {
      setDone("local");
      return;
    }
    if (final.sync.state === ReportSyncState.synced) {
      setDone("synced");
      return;
    }
    //rejected: the snapshot task is still open, the form stays with its answers and the alert says what the server said
    guard.current.submitted = false;
    setRejected(final);
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  if (loadError) return <Alert severity="error">{t(loadError)}</Alert>;
  if (!data || (!data.task && loading)) return <div className="page-loading"><CircularProgress /></div>;
  if (!data.task) {
    return (
      <div className="task-detail">
        <Link to="/courier" className="task-detail__back"><ChevronLeftIcon fontSize="small" /> {t("back")}</Link>
        <Alert severity="warning">{t("offline_task_unavailable")}</Alert>
      </div>
    );
  }

  const issuance = task.issuance;
  const lastAttempt = task.attempts?.slice(-1)[0];
  const closed = task.status !== TaskStatus.pending;
  const local = data.local_report;
  //the form waits for the draft too, so the pad mounts once with the right strokes
  if (!closed && (draft?.taskId !== taskId || formTaskId !== taskId)) return <div className="page-loading"><CircularProgress /></div>;

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
          {local && (
            <div className="task-detail__sync">
              <SyncChip state={local.sync.state} />
              <span className="muted small">{t("sync_saved_at", { time: formatDateTime(local.client_reported_at) })}</span>
              {local.ack && <span className="muted small">{t("sync_received_at", { time: formatDateTime(local.ack.reported_at) })}</span>}
              {/* the server's report above is the truth, this line says why the one saved here was refused */}
              {local.sync.state === ReportSyncState.conflict && local.sync.conflict_code && <span className="small">{t(`conflict_${local.sync.conflict_code}`)}</span>}
              <EvidenceLine report={local} scope={scope} />
              <Link to={`/courier/reports/${local.operation_id}`} className="small">{t("sync_view_report")}</Link>
            </div>
          )}
          {!data.detail_available && <Alert severity="warning" icon={false}>{t("offline_detail_unavailable")}</Alert>}
          {data.detail_available && lastAttempt && (
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
          {/* a report of this task the server refused, found on the device when the page opened */}
          {local && !isActiveState(local.sync.state) && !rejected && (
            <Alert severity="warning">
              {t("sync_task_rejected")} <button type="button" className="link-button" onClick={() => setListOpen(true)}>{t("sync_open_list")}</button>
            </Alert>
          )}

          <div className="task-detail__section-row">
            <h2 className="task-detail__section-title">{t("delivery_report")}</h2>
            <div className="draft-status">
              {draftState === "saving" && <span className="muted small">{t("draft_saving")}</span>}
              {draftState === "saved" && <span className="muted small">{t("draft_saved")}</span>}
              {draftState === "restored" && <span className="small draft-status__restored">{t("draft_restored")}</span>}
              {draftState === "failed" && <span className="small draft-status__failed">{t("draft_save_failed")}: {draftError}</span>}
              {hasDraft && <button type="button" className="link-button small" onClick={discardDraft}>{t("draft_discard")}</button>}
            </div>
          </div>
          {issuance.items.map((item, idx) => (
            <ItemReportCard
              key={item.id}
              item={item}
              index={idx}
              answer={answers[item.id] || {}}
              errors={errors[`item_${item.id}`] || {}}
              onChange={(a) => {
                setAnswers({ ...answers, [item.id]: a });
                touch();
              }}
            />
          ))}

          <h2 className="task-detail__section-title">{t("recipient_section")}</h2>
          <section className="task-section">
            <div className="item-report__question">{t("recipient_q")}</div>
            <div className="toggle-pair">
              <button type="button" className={recipientType === RecipientType.customer ? "is-active" : ""} onClick={() => { setRecipientType(RecipientType.customer); touch(); }}>{t("recipient_customer")}</button>
              <button type="button" className={recipientType === RecipientType.other ? "is-active" : ""} onClick={() => { setRecipientType(RecipientType.other); touch(); }}>{t("recipient_other")}</button>
            </div>

            {recipientType === RecipientType.other && (
              <div className="recipient-fields">
                <label>{t("recipient_name")}<span className="req">*</span></label>
                <TextField fullWidth value={recipient.name} error={!!errors.recipient_name} helperText={errors.recipient_name} onChange={(e) => { setRecipient({ ...recipient, name: e.target.value }); touch(); }} />
                <label>{t("recipient_id_number")}<span className="req">*</span></label>
                <TextField fullWidth value={recipient.id_number} error={!!errors.recipient_id_number} helperText={errors.recipient_id_number} inputProps={{ inputMode: "numeric" }} onChange={(e) => { setRecipient({ ...recipient, id_number: e.target.value }); touch(); }} />
                <label>{t("recipient_phone")}<span className="req">*</span></label>
                <TextField fullWidth value={recipient.phone} error={!!errors.recipient_phone} helperText={errors.recipient_phone} inputProps={{ inputMode: "tel" }} onChange={(e) => { setRecipient({ ...recipient, phone: e.target.value }); touch(); }} />
              </div>
            )}
          </section>

          {/* keyed by task so prev / next always remounts the pad: with local data there is no loading gap between tasks
              any more and the old strokes would otherwise stay on the canvas */}
          <SignaturePad key={`${task.id}:${padKey}`} strokes={strokes} onChange={onSignature} error={errors.signature} />

          {error && <Alert severity="error">{error}</Alert>}
          {rejected && (
            <Alert severity="error">
              {t(`sync_state_${rejected.sync.state}`)}
              {rejected.sync.state === ReportSyncState.conflict && rejected.sync.conflict_code
                ? ` ${t(`conflict_${rejected.sync.conflict_code}`)}`
                : rejected.sync.last_error ? ` ${t("sync_last_error", { error: rejected.sync.last_error })}` : ""}
              {" "}<Link to={`/courier/reports/${rejected.operation_id}`}>{t("sync_view_report")}</Link>
            </Alert>
          )}

          {/* on phone and tablet the strip sticks above the footer while the report scrolls (_courier.scss) */}
          <div className="task-detail__submit-bar">
            <Button variant="contained" size="large" fullWidth className="task-detail__submit" disabled={busy} onClick={submit}>
              {busy ? <CircularProgress size={20} color="inherit" /> : t("submit")}
            </Button>
          </div>
        </>
      )}

      {/* two different endings: the server has it, or only this device has it (for now) */}
      <Dialog open={done === "synced"} maxWidth="xs" fullWidth>
        <DialogContent className="success-dialog">
          <CheckCircleIcon className="success-dialog__icon" />
          <h2>{t("submit_done")}</h2>
          <Button variant="contained" onClick={() => navigate("/courier")}>{t("back_home")}</Button>
        </DialogContent>
      </Dialog>

      <Dialog open={done === "local"} maxWidth="xs" fullWidth>
        <DialogContent className="success-dialog success-dialog--local">
          <CloudQueueIcon className="success-dialog__icon" />
          <h2>{t("submit_saved_locally")}</h2>
          <p className="muted">{t("submit_saved_locally_hint")}</p>
          <Button variant="contained" onClick={() => navigate("/courier")}>{t("back_home")}</Button>
        </DialogContent>
      </Dialog>

      <PendingReportsDialog open={listOpen} onClose={() => setListOpen(false)} scope={scope} />
    </div>
  );
}

/*──────────────────────────────────────────────────────────────────────────*/

//resolves with the report once it left queued / syncing / auth, or with null after `ms`. the store subscription goes
//up before the first read: on a fast lan the worker's pass can be over before this even runs, and the re-read is what
//catches that
function waitForResult(scope: string, operationId: string, ms: number): Promise<LocalReport | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: LocalReport | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(r);
    };
    const check = () =>
      getReport(scope, operationId)
        .then((r) => {
          if (r && !PENDING_STATES.includes(r.sync.state)) finish(r);
        })
        .catch(() => {});
    const unsubscribe = subscribe((e) => {
      if (e.scope === scope && e.kind === "reports") check();
    });
    const timer = setTimeout(() => finish(null), ms);
    check();
  });
}
