import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { UserRole } from "../../../shared/@core";
import { homeOf, useAuth } from "../utils/auth";

import LoginPage from "../pages/LoginPage";
import ManagerLayout from "../manager/ManagerLayout";
import IssuancesBoard from "../manager/pages/IssuancesBoard";
import CouriersPage from "../manager/pages/CouriersPage";
import ReportsPage from "../manager/pages/ReportsPage";
import CourierLayout from "../courier/CourierLayout";
import DeliveryBoard from "../courier/pages/DeliveryBoard";
import TaskDetailPage from "../courier/pages/TaskDetailPage";

//two separate trees, like the information architecture diagram: צד מנהל מחסן under /manager, צד משנע under /courier
export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route path="/manager" element={<RequireRole role={UserRole.manager}><ManagerLayout /></RequireRole>}>
          <Route index element={<Navigate to="issuances" replace />} />
          <Route path="issuances" element={<IssuancesBoard />} />
          <Route path="couriers" element={<CouriersPage />} />
          <Route path="reports" element={<ReportsPage />} />
        </Route>

        <Route path="/courier" element={<RequireRole role={UserRole.courier}><CourierLayout /></RequireRole>}>
          <Route index element={<DeliveryBoard />} />
          <Route path="tasks/:id" element={<TaskDetailPage />} />
        </Route>

        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}

/*──────────────────────────────────────────────────────────────────────────*/

function RequireRole({ role, children }: { role: UserRole; children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  //a courier that types /manager lands on their own board, not on a 403
  if (user.role !== role) return <Navigate to={homeOf(user)} replace />;
  return <>{children}</>;
}

/*──────────────────────────────────────────────────────────────────────────*/

function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={user ? homeOf(user) : "/login"} replace />;
}
