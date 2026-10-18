import { Navigate } from "react-router-dom";

import { UserRole } from "../../../shared/@core";
import { hasRole } from "../../../shared/auth";
import { homeOf, useAuth } from "../utils/auth";

//the two route trees of AppRouter sit behind these. the check reads the roles the server put in the session: a manager
//holds the courier role too and passes both trees, a courier that types /manager lands on their own board, not on a 403
export function RequireRole({ role, children }: { role: UserRole; children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!user.roles.includes(role)) return <Navigate to={homeOf(user)} replace />;
  //the courier screens store and fetch by the courier row; a manager without one has nothing to see there and the
  //manager shell hides the link, so a typed /courier goes back to the board the same way
  if (role === UserRole.courier && user.courier_id == null && hasRole(user, UserRole.manager)) return <Navigate to={homeOf(user)} replace />;
  return <>{children}</>;
}

/*──────────────────────────────────────────────────────────────────────────*/

export function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={user ? homeOf(user) : "/login"} replace />;
}
