import { Navigate } from "react-router-dom";

import { UserRole } from "../../../shared/@core";
import { homeOf, useAuth } from "../utils/auth";

//the two route trees of AppRouter sit behind these. the check reads the roles the server put in the session: a manager
//holds the courier role too and passes both trees, a courier that types /manager lands on their own board, not on a 403
export function RequireRole({ role, children }: { role: UserRole; children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  //the roles alone decide: a courier row (the business identity of the courier screens) is not a condition of entry,
  //the courier shell says when the account has none
  if (!user.roles.includes(role)) return <Navigate to={homeOf(user)} replace />;
  return <>{children}</>;
}

/*──────────────────────────────────────────────────────────────────────────*/

export function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={user ? homeOf(user) : "/login"} replace />;
}
