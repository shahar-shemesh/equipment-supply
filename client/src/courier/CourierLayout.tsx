import { Link, Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import LogoutIcon from "@mui/icons-material/Logout";

import { Logo } from "../components/Logo";
import { useAuth } from "../utils/auth";

//tablet / phone shell for the courier: slim gradient header, content, and the fixed "לוח משלוחים" bar at the bottom
export default function CourierLayout() {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const navigate = useNavigate();

  function signOut() {
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

      <main className="courier-content">
        <Outlet />
      </main>

      <footer className="courier-footer">
        <Logo />
        <Link to="/courier">{t("courier_footer")}</Link>
      </footer>
    </div>
  );
}
