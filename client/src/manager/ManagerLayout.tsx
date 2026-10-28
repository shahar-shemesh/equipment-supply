import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Drawer, IconButton } from "@mui/material";
import LogoutIcon from "@mui/icons-material/Logout";
import MenuIcon from "@mui/icons-material/Menu";
import CloseIcon from "@mui/icons-material/Close";
import HistoryIcon from "@mui/icons-material/History";

import { UserRole } from "../../../shared/@core";
import { hasRole } from "../../../shared/auth";
import { Logo } from "../components/Logo";
import { useAuth } from "../utils/auth";
import { useBreakpoint } from "../utils/useBreakpoint";
import { scopeOf } from "../courier/offline/identity";
import { clearSyncedData } from "../courier/offline/store";

//desktop shell for the warehouse manager: gradient header with the top navigation from the design.
//below the desktop width the nav and the user block move into a drawer behind a hamburger, the header itself stays
export default function ManagerLayout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { desktop } = useBreakpoint();
  const [menuOpen, setMenuOpen] = useState(false);
  //a manager holds the courier role too: the link to the courier screens (by the role alone), and the scope those
  //screens stored under (by the courier row, null without one)
  const scope = scopeOf(user);
  const courierView = hasRole(user, UserRole.courier);

  //growing past 1200 hides the drawer, this clears the state too so shrinking back does not reopen it by itself
  useEffect(() => {
    if (desktop) setMenuOpen(false);
  }, [desktop]);

  //the same order as the courier layout's leave: the session ends first, then the server's copies this account pulled
  //through the courier screens leave the device, while the reports the server never acknowledged and the drafts stay
  //(docs/offline-sync.md). no sync pass before it: the manager leaves from the manager screens, the courier worker is
  //already stopped with its layout, and whatever is queued goes out on the account's next courier start. a failed
  //cleanup is not a reason to stay, the next start sweeps
  async function signOut() {
    setMenuOpen(false);
    logout();
    if (scope) await clearSyncedData(scope).catch(() => {});
    navigate("/login");
  }

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <div className="manager-shell">
      <header className="app-header app-header--manager">
        <div className="app-header__brand">
          <Logo />
          <span>{t("app_name")}</span>
        </div>
        {desktop ? (
          <>
            <nav className="app-header__nav">
              <NavLink to="/manager/issuances">{t("nav_issuances")}</NavLink>
              <NavLink to="/manager/couriers">{t("nav_couriers")}</NavLink>
              <NavLink to="/manager/conflicts">{t("nav_conflicts")}</NavLink>
              <NavLink to="/manager/audit"><HistoryIcon fontSize="small" />{t("nav_audit")}</NavLink>
              <NavLink to="/manager/reports">{t("nav_reports")}</NavLink>
              {courierView && <NavLink to="/courier">{t("nav_courier_view")}</NavLink>}
            </nav>
            <div className="app-header__user">
              <span>{user?.name}</span>
              <button type="button" className="app-header__logout" onClick={signOut}>
                {t("logout")}
                <LogoutIcon fontSize="small" />
              </button>
            </div>
          </>
        ) : (
          <IconButton className="app-header__menu-btn" aria-label={t("menu")} onClick={() => setMenuOpen(true)}>
            <MenuIcon />
          </IconButton>
        )}
      </header>

      {/* mui mirrors the anchor under direction rtl and the stylis plugin flips the css again, so "left" is what lands
          on the visual right (the start side) here. "right" would open it on the left */}
      <Drawer anchor="left" open={menuOpen && !desktop} onClose={closeMenu} className="manager-drawer">
        <div className="manager-drawer__head">
          <Logo dark />
          <span>{t("app_name")}</span>
          <IconButton aria-label={t("close")} onClick={closeMenu}><CloseIcon /></IconButton>
        </div>
        <nav className="manager-drawer__nav">
          <NavLink to="/manager/issuances" onClick={closeMenu}>{t("nav_issuances")}</NavLink>
          <NavLink to="/manager/couriers" onClick={closeMenu}>{t("nav_couriers")}</NavLink>
          <NavLink to="/manager/conflicts" onClick={closeMenu}>{t("nav_conflicts")}</NavLink>
          <NavLink to="/manager/audit" onClick={closeMenu}><HistoryIcon fontSize="small" />{t("nav_audit")}</NavLink>
          <NavLink to="/manager/reports" onClick={closeMenu}>{t("nav_reports")}</NavLink>
          {courierView && <NavLink to="/courier" onClick={closeMenu}>{t("nav_courier_view")}</NavLink>}
        </nav>
        <div className="manager-drawer__user">
          <span>{user?.name}</span>
          <button type="button" className="manager-drawer__logout" onClick={signOut}>
            {t("logout")}
            <LogoutIcon fontSize="small" />
          </button>
        </div>
      </Drawer>

      <main className="manager-content">
        <Outlet />
      </main>
    </div>
  );
}
