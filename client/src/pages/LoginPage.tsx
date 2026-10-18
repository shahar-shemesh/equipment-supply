import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@mui/material";

import { AuthMode, MockIdentity } from "../../../shared/@core";
import { Logo } from "../components/Logo";
import { homeOf, useAuth } from "../utils/auth";
import { errorMessage, SessionEnd, takeSessionEnd } from "../utils/service";
import { useOtherAccountsWork } from "../courier/offline/useCourierData";

//what the page offers is the server's mode (GET /api/auth/mode through the provider): two identity buttons in mock
//mode, the boundary message in cognito mode, nothing but a loading line until the answer is in
export default function LoginPage() {
  const { t } = useTranslation();
  const { user, mode, modeError, signIn } = useAuth();
  const navigate = useNavigate();

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  //every account on this device with reports still waiting to go out, whoever signs in next should know
  const { data: pendingWork } = useOtherAccountsWork(null);
  //why the last session ended (clearSession wrote the note), consumed once so a reload of this page does not repeat it
  const [sessionEnd, setSessionEnd] = useState<SessionEnd | null>(null);

  useEffect(() => {
    const end = takeSessionEnd();
    if (end) setSessionEnd(end);
  }, []);

  useEffect(() => {
    if (user) navigate(homeOf(user), { replace: true });
  }, [user]);

  //login needs the server, so the page says when there is no network at all (onLine is a hint, the attempt still runs)
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  async function enter(identity: MockIdentity) {
    setBusy(true);
    setError("");
    try {
      const u = await signIn({ identity });
      navigate(homeOf(u), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__logo">
          <Logo dark />
          <span>{t("app_name_long")}</span>
        </div>
        <h1>{t("login_title")}</h1>

        {!online && <Alert severity="warning">{t("login_offline")}</Alert>}
        {sessionEnd?.reason === "expired" && <Alert severity="warning">{t("session_expired")}</Alert>}
        {/* what went out before the logout; what stayed behind, the pending notice below says (rejected reports are not
            in it: they wait in the device's list for the same account, nothing to send) */}
        {sessionEnd?.reason === "logout" && (sessionEnd.sent ?? 0) > 0 && (
          <Alert severity="success">{t(sessionEnd.sent === 1 ? "logout_synced_one" : "logout_synced_count", { count: sessionEnd.sent })}</Alert>
        )}
        {pendingWork.map((w) => (
          <Alert key={w.scope} severity="info">{t(w.count === 1 ? "login_pending_work_one" : "login_pending_work", { count: w.count, name: w.display_name || w.username })}</Alert>
        ))}

        {mode === AuthMode.mock && (
          <>
            <Alert severity="warning" icon={false}>{t("login_mock_banner")}</Alert>
            <div className="login-card__identities">
              <Button variant="contained" size="large" disabled={busy} onClick={() => enter(MockIdentity.manager)}>
                {t("login_as_manager")}
              </Button>
              <Button variant="outlined" size="large" disabled={busy} onClick={() => enter(MockIdentity.courier)}>
                {t("login_as_courier")}
              </Button>
            </div>
          </>
        )}
        {mode === AuthMode.cognito && <Alert severity="info">{t("login_cognito_missing")}</Alert>}
        {!mode && modeError && <Alert severity="error">{t("login_server_unreachable")}</Alert>}
        {!mode && !modeError && <p className="login-card__loading">{t("login_mode_loading")}</p>}

        {error && <Alert severity="error">{error}</Alert>}
      </div>
    </div>
  );
}
