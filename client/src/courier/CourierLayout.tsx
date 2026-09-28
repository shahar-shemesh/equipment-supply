import { useEffect, useState } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogContent } from "@mui/material";
import LogoutIcon from "@mui/icons-material/Logout";

import { Logo } from "../components/Logo";
import { useAuth } from "../utils/auth";
import { currentToken, scopeOf, tokenIsFresh } from "./offline/identity";
import { requestPersistentStorage } from "./offline/storage";
import { refresh, refreshIfStale } from "./offline/store";
import { getSyncStatus, startSync, stopSync } from "./offline/sync";
import { SyncStatusBar } from "./components/SyncStatusBar";

//tablet / phone shell for the courier: slim gradient header, the sync strip, content, and the fixed "לוח משלוחים" bar
//at the bottom. the offline worker lives as long as this layout is mounted for one account
export default function CourierLayout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const scope = scopeOf(user);
  const [confirmCount, setConfirmCount] = useState(0);

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
      stopSync();
      window.removeEventListener("online", stale);
      window.removeEventListener("focus", stale);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [scope]);

  //reports that did not reach the server stay on the device (logout clears localStorage only), but the courier should
  //know before leaving that they will only go out after the same account signs in again
  function signOut() {
    const s = getSyncStatus();
    const n = s.pending + s.attention;
    if (n > 0) {
      setConfirmCount(n);
      return;
    }
    leave();
  }

  function leave() {
    stopSync();
    logout();
    navigate("/login");
  }

  return (
    <div className="courier-shell">
      <header className="app-header app-header--courier">
        <Logo />
        <button type="button" className="app-header__logout" onClick={signOut}>
          {t("logout")}
          <LogoutIcon fontSize="small" />
        </button>
      </header>

      <SyncStatusBar />

      <main className="courier-content">
        <Outlet />
      </main>

      <footer className="courier-footer">
        <Logo />
        <Link to="/courier">{t("courier_footer")}</Link>
      </footer>

      <Dialog open={confirmCount > 0} onClose={() => setConfirmCount(0)} maxWidth="xs" fullWidth>
        <DialogContent className="confirm-dialog">
          <p>{t("logout_pending_work", { count: confirmCount })}</p>
          <div className="confirm-dialog__actions">
            <Button variant="contained" onClick={leave}>{t("logout")}</Button>
            <Button variant="outlined" onClick={() => setConfirmCount(0)}>{t("cancel")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
