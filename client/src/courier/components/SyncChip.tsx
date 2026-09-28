import { useTranslation } from "react-i18next";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import CloudDoneOutlinedIcon from "@mui/icons-material/CloudDoneOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";

import { ReportSyncState } from "../../../../shared/@core";

const ATTENTION = [ReportSyncState.invalid, ReportSyncState.forbidden, ReportSyncState.conflict];

//where a report saved on this device stands with the server, next to the business status badge. the short form is the
//card label (נשמר במכשיר), the long one spells the state out (sync_state_*). a separate axis from StatusBadge on purpose
export function SyncChip({ state, short = false }: { state: ReportSyncState; short?: boolean }) {
  const { t } = useTranslation();
  if (state === ReportSyncState.synced) {
    return <span className="report-chip report-chip--synced"><CloudDoneOutlinedIcon fontSize="inherit" /> {t("sync_state_synced")}</span>;
  }
  if (ATTENTION.includes(state)) {
    return <span className="report-chip report-chip--attention"><ErrorOutlineIcon fontSize="inherit" /> {t(`sync_state_${state}`)}</span>;
  }
  return <span className="report-chip report-chip--pending"><CloudQueueIcon fontSize="inherit" /> {t(short ? "local_report_badge" : `sync_state_${state}`)}</span>;
}
