import { Component, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Button, CircularProgress } from "@mui/material";

import { UserRole } from "../../../shared/@core";
import { HomeRedirect, RequireRole } from "./guards";

import LoginPage from "../pages/LoginPage";
import ManagerLayout from "../manager/ManagerLayout";
import CouriersPage from "../manager/pages/CouriersPage";
import ReportsPage from "../manager/pages/ReportsPage";
import ConflictsPage from "../manager/pages/ConflictsPage";
import CourierLayout from "../courier/CourierLayout";
import DeliveryBoard from "../courier/pages/DeliveryBoard";
import TaskDetailPage from "../courier/pages/TaskDetailPage";
import ReportDetailPage from "../courier/pages/ReportDetailPage";

//the board pulls in the data grid: a chunk of its own, out of the entry bundle and out of the courier's precache
//(globIgnores in vite.config.ts)
const IssuancesBoard = lazy(() => import("../manager/pages/IssuancesBoard"));

//two separate trees, like the information architecture diagram: צד מנהל מחסן under /manager, צד משנע under /courier
export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route path="/manager" element={<RequireRole role={UserRole.manager}><ManagerLayout /></RequireRole>}>
          <Route index element={<Navigate to="issuances" replace />} />
          <Route path="issuances" element={<ChunkBoundary><Suspense fallback={<div className="page-loading"><CircularProgress /></div>}><IssuancesBoard /></Suspense></ChunkBoundary>} />
          <Route path="couriers" element={<CouriersPage />} />
          <Route path="conflicts" element={<ConflictsPage />} />
          <Route path="reports" element={<ReportsPage />} />
        </Route>

        <Route path="/courier" element={<RequireRole role={UserRole.courier}><CourierLayout /></RequireRole>}>
          <Route index element={<DeliveryBoard />} />
          <Route path="tasks/:id" element={<TaskDetailPage />} />
          {/* a report saved on this device, by its operation id. lives under the layout so the sync strip stays */}
          <Route path="reports/:operationId" element={<ReportDetailPage />} />
        </Route>

        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}

/*──────────────────────────────────────────────────────────────────────────*/

//a lazy chunk can fail to load: the index.html the service worker kept from before a deploy asks for a hash the server
//no longer has, or the network dropped. without a boundary react unmounts the whole tree into a blank page
class ChunkBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <LoadFailed /> : this.props.children;
  }
}

function LoadFailed() {
  const { t } = useTranslation();
  return (
    <div className="page-loading page-loading--failed">
      <span>{t("page_load_failed")}</span>
      <Button variant="outlined" onClick={() => window.location.reload()}>{t("page_reload")}</Button>
    </div>
  );
}
