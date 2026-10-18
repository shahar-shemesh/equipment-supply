import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Button, CircularProgress, Dialog, DialogContent } from "@mui/material";
import LogoutIcon from "@mui/icons-material/Logout";

import { UserRole } from "../../../shared/@core";
import { hasRole } from "../../../shared/auth";
import { Logo } from "../components/Logo";
import { useAuth } from "../utils/auth";
import { currentToken, scopeOf, tokenIsFresh } from "./offline/identity";
import { requestPersistentStorage } from "./offline/storage";
import { clearSyncedData, countReports, refresh, refreshIfStale } from "./offline/store";
import { flushForLogout, getSyncStatus, startSync, stopSync } from "./offline/sync";
import { SyncStatusBar } from "./components/SyncStatusBar";

//tablet / phone shell for the courier: slim gradient header, the sync strip, content, and the fixed "לוח משלוחים" bar
//at the bottom. the offline worker lives as long as this layout is mounted for one account
export default function CourierLayout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const scope = scopeOf(user);
  //the confirm dialog: how many reports stay on the device, how many went out just now, whether a pass ran and fell short
  const [confirm, setConfirm] = useState<{ count: number; sent: number; incomplete: boolean } | null>(null);
  const [syncing, setSyncing] = useState(false);
  //bumped by cancel and by a scope change, so a pass that finishes after either changes nothing here
  const flushRun = useRef(0);

  //one worker per account: start it, ask the browser to keep the storage, pull the snapshot when the server is
  //reachable, and pull it again (throttled) whenever the app comes back to the foreground or the network returns
  useEffect(() => {
    if (!scope) return;
    startSync(scope, { afterSynced: (s) => refresh(s) }).catch(() => {});
    requestPersistentStorage(scope);
    if (navigator.onLine && tokenIsFresh(currentToken())) refresh(scope);

    const stale = () => {
      if (navigator.onLine && tokenIsFresh(currentToken())) refreshIfStale(scope, 60_000);
    };
    const visible = () => {
      if (document.visibilityState === "visible") stale();
    };
    window.addEventListener("online", stale);
    window.addEventListener("focus", stale);
    document.addEventListener("visibilitychange", visible);
    return () => {
      //an account switch made in another tab lands here with the dialogs of the old account possibly open
      flushRun.current++;
      setSyncing(false);
      setConfirm(null);
      stopSync();
      window.removeEventListener("online", stale);
      window.removeEventListener("focus", stale);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [scope]);

  //reports that did not reach the server stay on the device under this account, so before leaving, what can go out now
  //goes out: one bounded pass when the device is online under a fresh token, behind a dialog the courier may cancel
  //(rejected reports ride too: their evidence goes up in the same pass). what is still to send after it, or everything
  //without a pass (offline, token expired), asks for confirmation. the counts come from the database, not from the
  //worker's status: a pass still running for the report just sent has not refreshed the status yet
  async function signOut() {
    if (!scope) return leave(0);
    const run = ++flushRun.current;
    const c = await countReports(scope).catch(() => ({ pending: getSyncStatus().pending, attention: getSyncStatus().attention }));
    if (run !== flushRun.current) return;
    if (c.pending + c.attention === 0) return leave(0);
    if (navigator.onLine && tokenIsFresh(currentToken())) {
      setSyncing(true);
      const r = await flushForLogout();
      if (run !== flushRun.current) return;
      setSyncing(false);
      if (r.pending + r.attention === 0) return leave(r.sent);
      setConfirm({ count: r.pending + r.attention, sent: r.sent, incomplete: r.pending > 0 });
      return;
    }
    setConfirm({ count: c.pending + c.attention, sent: 0, incomplete: false });
  }

  //the pass itself goes on in the worker, only its result is no longer waited for
  function cancelFlush() {
    flushRun.current++;
    setSyncing(false);
  }

  //the order matters: the worker stops first (a late answer is dropped), the session ends with the note for the login
  //page (a refresh that starts from now on is refused before it fetches, there is no token), and only then the server's
  //copies of this account leave the device while the reports it never acknowledged and the drafts stay. a failed
  //cleanup is not a reason to stay: the next start sweeps
  async function leave(sent: number) {
    stopSync();
    logout({ reason: "logout", sent });
    if (scope) await clearSyncedData(scope).catch(() => {});
    navigate("/login");
  }

  return (
    <div className="courier-shell">
      <header className="app-header app-header--courier">
        <Logo />
        <div className="app-header__actions">
          {/* a manager holds the courier role too and came from the board: the way back, no second login */}
          {hasRole(user, UserRole.manager) && <Link to="/manager/issuances" className="app-header__link">{t("nav_manager_view")}</Link>}
          <button type="button" className="app-header__logout" onClick={signOut}>
            {t("logout")}
            <LogoutIcon fontSize="small" />
          </button>
        </div>
      </header>

      {/* the strip reads and refreshes by the scope: nothing to say without one */}
      {scope && <SyncStatusBar />}

      <main className="courier-content">
        {/* the role opened the screens, the courier row is what they work by: without one (a manager whose account has
            no courier row) there is nothing to fetch or store, so the notice stands where the board would */}
        {scope ? (
          <Outlet />
        ) : (
          <Alert severity="info" className="courier-no-identity">
            {t("courier_no_identity")} {hasRole(user, UserRole.manager) ? t("courier_no_identity_manager") : t("courier_no_identity_courier")}
          </Alert>
        )}
      </main>

      <footer className="courier-footer">
        <Logo />
        <Link to="/courier">{t("courier_footer")}</Link>
      </footer>

      <Dialog open={syncing} onClose={cancelFlush} maxWidth="xs" fullWidth>
        <DialogContent className="confirm-dialog">
          <CircularProgress size={28} />
          <p>{t("logout_syncing")}</p>
          <div className="confirm-dialog__actions">
            <Button variant="outlined" onClick={cancelFlush}>{t("cancel")}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirm} onClose={() => setConfirm(null)} maxWidth="xs" fullWidth>
        <DialogContent className="confirm-dialog">
          {confirm?.incomplete && <p>{t("logout_sync_incomplete")}</p>}
          <p>{t("logout_pending_work", { count: confirm?.count ?? 0 })}</p>
          <div className="confirm-dialog__actions">
            <Button variant="contained" onClick={() => leave(confirm?.sent ?? 0)}>{t("logout")}</Button>
            <Button variant="outlined" onClick={() => setConfirm(null)}>{t("cancel")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
