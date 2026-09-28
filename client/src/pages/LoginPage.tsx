import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Button, TextField } from "@mui/material";

import { Logo } from "../components/Logo";
import { homeOf, useAuth } from "../utils/auth";
import { get } from "../utils/service";
import { useOtherAccountsWork } from "../courier/offline/useCourierData";

export default function LoginPage() {
  const { t } = useTranslation();
  const { user, login } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [accounts, setAccounts] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  //every account on this device with reports still waiting to go out, whoever signs in next should know
  const { data: pendingWork } = useOtherAccountsWork(null);

  //the seeded accounts, only returned by the server in dev-local
  useEffect(() => {
    get("/auth/dev-accounts").then(setAccounts).catch(() => setAccounts([]));
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const u = await login(username, password);
      navigate(homeOf(u), { replace: true });
    } catch (err) {
      // console.log("login failed", err);
      setError(t("login_failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-card__logo">
          <Logo dark />
          <span>{t("app_name_long")}</span>
        </div>
        <h1>{t("login_title")}</h1>

        {!online && <Alert severity="warning">{t("login_offline")}</Alert>}
        {pendingWork.map((w) => (
          <Alert key={w.scope} severity="info">{t(w.count === 1 ? "login_pending_work_one" : "login_pending_work", { count: w.count, name: w.display_name || w.username })}</Alert>
        ))}

        {/* phone keyboards capitalize the first letter and autocorrect by default, the server matches the username as typed */}
        <TextField label={t("login_username")} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus fullWidth autoComplete="username" inputProps={{ autoCapitalize: "none", autoCorrect: "off", spellCheck: false }} />
        <TextField label={t("login_password")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} fullWidth autoComplete="current-password" />

        {error && <Alert severity="error">{error}</Alert>}

        <Button type="submit" variant="contained" size="large" disabled={busy || !username || !password}>
          {t("login_button")}
        </Button>

        {accounts.length > 0 && (
          <div className="login-card__dev">
            <Alert severity="warning" icon={false}>{t("login_dev_banner")}</Alert>
            <div className="login-card__dev-title">{t("login_dev_accounts")}</div>
            <ul>
              {accounts.map((a) => (
                <li key={a.username}>
                  <button type="button" className="link-button" onClick={() => { setUsername(a.username); setPassword(a.password); }}>
                    {a.username}
                  </button>
                  <span> - {a.display_name}, {t(a.role === "manager" ? "role_manager" : "role_courier")}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </div>
  );
}
