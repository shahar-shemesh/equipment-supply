import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";
import WifiOffIcon from "@mui/icons-material/WifiOff";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import CloudDoneOutlinedIcon from "@mui/icons-material/CloudDoneOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";

import { useAuth } from "../../utils/auth";
import { isSecureContext, scopeOf } from "../offline/identity";
import { refresh } from "../offline/store";
import { stopSync } from "../offline/sync";
import { useBoard, useOtherAccountsWork, useSyncStatus } from "../offline/useCourierData";
import { applyUpdate, isUpdateReady, subscribeSw } from "../offline/sw";
import { PendingReportsDialog } from "./PendingReportsDialog";

//the slim strip under the courier header: network, the prepared dataset, the send queue. plain buttons, not mui ones:
//_basic.scss forces 44px on .MuiButton-root under the touch query and this strip has to stay at 36
export function SyncStatusBar() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const scope = scopeOf(user);
  const { data: status } = useSyncStatus();
  //the board hook for ready + refreshed_at only, the tab and search do not matter here
  const { data: board } = useBoard(scope, "all", "");
  const { data: others } = useOtherAccountsWork(scope);
  const [updateReady, setUpdateReady] = useState(isUpdateReady());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => subscribeSw(setUpdateReady), []);

  async function refreshNow() {
    if (!scope || refreshing) return;
    setRefreshing(true);
    const r = await refresh(scope);
    setRefreshFailed(!r.ok);
    setRefreshing(false);
  }

  //back to the login page with the queue untouched: the worker stops first so no old result lands in the next session,
  //logout clears localStorage only (indexeddb keeps the reports). a plain link would bounce, LoginPage redirects a logged in user
  function reauth() {
    stopSync();
    logout();
    navigate("/login");
  }

  const online = status.online;
  const ready = !!board?.ready;
  const refreshedAt = board?.refreshed_at ? dayjs(board.refreshed_at) : null;
  const refreshedLabel = refreshedAt ? (refreshedAt.isSame(dayjs(), "day") ? refreshedAt.format("HH:mm") : refreshedAt.format("DD/MM HH:mm")) : "";

  return (
    <>
      <div className="sync-bar">
        <span className={`sync-chip sync-chip--net ${!online || status.reachable === false ? "is-off" : ""}`}>
          {!online ? <><WifiOffIcon fontSize="inherit" /> {t("net_offline")}</> : status.reachable === false ? <><CloudOffIcon fontSize="inherit" /> {t("net_server_unreachable")}</> : t("net_online")}
        </span>

        <span className="sync-chip sync-chip--data">
          {ready ? `${t("offline_ready")}, ${t("offline_refreshed_at", { time: refreshedLabel })}` : online ? t("offline_preparing") : t("offline_never_refreshed")}
        </span>

        <button type="button" className={`sync-chip sync-chip--action ${refreshing ? "is-busy" : ""}`} disabled={!online || refreshing || !scope} onClick={refreshNow} title={t("offline_refresh")}>
          <RefreshIcon fontSize="inherit" /> {t("offline_refresh")}
        </button>
        {refreshFailed && <span className="sync-chip sync-chip--warn">{t("offline_refresh_failed")}</span>}

        {status.auth_required && (
          <button type="button" className="sync-chip sync-chip--warn sync-chip--action" onClick={reauth}>
            <LockOutlinedIcon fontSize="inherit" /> {t("sync_auth_required")}
          </button>
        )}

        <button type="button" className={`sync-chip sync-chip--action ${status.pending ? "is-pending" : ""}`} onClick={() => setListOpen(true)}>
          {status.running ? <><CloudQueueIcon fontSize="inherit" /> {t("sync_syncing")}</>
            : status.pending === 1 ? <><CloudQueueIcon fontSize="inherit" /> {t("sync_pending_one")}</>
            : status.pending > 1 ? <><CloudQueueIcon fontSize="inherit" /> {t("sync_pending_count", { count: status.pending })}</>
            : status.last_sync_at ? <><CloudDoneOutlinedIcon fontSize="inherit" /> {t("sync_all_synced")}</>
            : t("sync_open_list")}
        </button>

        {status.attention > 0 && (
          <button type="button" className="sync-chip sync-chip--warn sync-chip--action" onClick={() => setListOpen(true)}>
            <ErrorOutlineIcon fontSize="inherit" /> {status.attention === 1 ? t("sync_attention_one") : t("sync_attention_count", { count: status.attention })}
          </button>
        )}

        {updateReady && (
          <button type="button" className="sync-chip sync-chip--action sync-chip--update" onClick={() => applyUpdate()}>
            <SystemUpdateAltIcon fontSize="inherit" /> {t("update_available")}: {t("update_reload")}
          </button>
        )}

        {/* the notices take a line of their own so the chips above stay on one */}
        {!isSecureContext() && <div className="sync-bar__notice">{t("offline_insecure_context")}</div>}
        {others.map((o) => (
          <div key={o.scope} className="sync-bar__notice">{t(o.count === 1 ? "sync_other_account_one" : "sync_other_account", { count: o.count, name: o.display_name || o.username })}</div>
        ))}
      </div>

      <PendingReportsDialog open={listOpen} onClose={() => setListOpen(false)} scope={scope} />
    </>
  );
}
