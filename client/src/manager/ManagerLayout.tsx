import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import LogoutIcon from "@mui/icons-material/Logout";

import { Logo } from "../components/Logo";
import { useAuth } from "../utils/auth";

//desktop shell for the warehouse manager: gradient header with the top navigation from the design
export default function ManagerLayout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function signOut() {
    logout();
    navigate("/login");
  }

  return (
    <div className="manager-shell">
      <header className="app-header app-header--manager">
        <div className="app-header__brand">
          <Logo />
          <span>{t("app_name")}</span>
        </div>
        <nav className="app-header__nav">
          <NavLink to="/manager/issuances">{t("nav_issuances")}</NavLink>
          <NavLink to="/manager/couriers">{t("nav_couriers")}</NavLink>
          <NavLink to="/manager/reports">{t("nav_reports")}</NavLink>
        </nav>
        <div className="app-header__user">
          <span>{user?.display_name}</span>
          <button type="button" className="app-header__logout" onClick={signOut}>
            {t("logout")}
            <LogoutIcon fontSize="small" />
          </button>
        </div>
      </header>

      <main className="manager-content">
        <Outlet />
      </main>
    </div>
  );
}
