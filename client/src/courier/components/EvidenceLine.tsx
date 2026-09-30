import { useState } from "react";
import { useTranslation } from "react-i18next";

import { EvidenceUploadState, ReportSyncState } from "../../../../shared/@core";
import { formatDateTime } from "../../utils/format";
import { LocalReport } from "../offline/db";
import { evidenceOf, retryEvidence } from "../offline/store";
import { kickSync } from "../offline/sync";

//where the evidence of a rejected report stands: only on this device, on its way, with the manager, or looked at by the
//manager. shown under the conflict chip on the task page, the report page and the pending dialog. "reviewed" is not
//"applied": the delivery report stays refused and the line says so
export function EvidenceLine({ report, scope }: { report: LocalReport; scope: string | null }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  if (report.sync.state !== ReportSyncState.conflict) return null;
  const e = evidenceOf(report);

  async function retry() {
    setBusy(true);
    try {
      await retryEvidence(scope, report.operation_id);
      await kickSync("retry");
    } finally {
      setBusy(false);
    }
  }

  let text: string;
  switch (e.state) {
    case EvidenceUploadState.received:
      text = t("evidence_received", { time: formatDateTime(e.received_at) });
      break;
    case EvidenceUploadState.reviewed:
      text = t("evidence_reviewed", { time: formatDateTime(e.reviewed_at || e.received_at) });
      break;
    case EvidenceUploadState.uploading:
      text = t("evidence_uploading");
      break;
    case EvidenceUploadState.failed:
      text = t("evidence_failed", { error: e.last_error || "" });
      break;
    case EvidenceUploadState.pending:
      text = e.next_at ? `${t("evidence_pending")} (${t("sync_next_try", { time: formatDateTime(e.next_at) })})` : t("evidence_pending");
      break;
    default:
      //not sent yet: the worker picks it up on its next pass, until then the manager has nothing
      text = t("evidence_local_only");
  }
  const canRetry = e.state === EvidenceUploadState.failed || (e.state === EvidenceUploadState.pending && !!e.next_at);

  return (
    <div className={`evidence-line evidence-line--${e.state}`}>
      <span>{text}</span>
      {canRetry && scope && <button type="button" className="link-button" disabled={busy} onClick={retry}>{t("evidence_retry")}</button>}
    </div>
  );
}
