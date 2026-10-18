import { UserRole } from "./@core";

// the role list behind one users.role. a manager holds the courier role too: the product wants the warehouse manager to
// open the courier screens without a second login. the server derives it when it issues or verifies a token, the client
// only reads the list it was given, so a change here moves both sides at once
export function rolesOf(role: UserRole | null | undefined): UserRole[] {
  if (role === UserRole.manager) return [UserRole.manager, UserRole.courier];
  if (role === UserRole.courier) return [UserRole.courier];
  return [];
}

/*──────────────────────────────────────────────────────────────────────────*/

// the one role a row keeps. the audit log, the xml payload and the log lines were written with a single role and keep
// that column; the higher one wins, so a manager's actions read as a manager's wherever they were made
export function primaryRole(roles: UserRole[] | null | undefined): UserRole | null {
  if (!roles?.length) return null;
  if (roles.includes(UserRole.manager)) return UserRole.manager;
  if (roles.includes(UserRole.courier)) return UserRole.courier;
  return roles[0];
}

/*──────────────────────────────────────────────────────────────────────────*/

export function hasRole(user: { roles?: UserRole[] | null } | null | undefined, role: UserRole): boolean {
  return !!user?.roles?.includes(role);
}
