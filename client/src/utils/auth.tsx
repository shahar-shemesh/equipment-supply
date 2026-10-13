import { createContext, useContext, useEffect, useState } from "react";

import { IUser, UserRole } from "../../../shared/@core";
import { clearSession, post, SessionEnd, TOKEN_KEY, USER_KEY } from "./service";
import { watchTokenExpiry } from "../courier/offline/identity";

//dev-local auth only: username + password against the seeded accounts. the token is a plain jwt in localStorage.
//when the production identity provider is decided this file is the place that changes on the client side
type AuthCtx = {
  user: IUser | null;
  login: (username: string, password: string) => Promise<IUser>;
  logout: (end?: SessionEnd) => void;
};

const Ctx = createContext<AuthCtx>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<IUser | null>(() => {
    try {
      return normalizeUser(JSON.parse(localStorage.getItem(USER_KEY) || "null"));
    } catch (e) {
      return null;
    }
  });

  //a login or logout in another tab of the same browser: this tab follows it instead of staying on the old account with
  //the new account's token in storage (the courier screens restart their sync worker when the user changes)
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== USER_KEY && e.key !== null) return;
      try {
        setUser(normalizeUser(JSON.parse(localStorage.getItem(USER_KEY) || "null")));
      } catch (err) {
        setUser(null);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  //the client side end of the 12 hour token: at exp, or on the first focus after it, the session is gone without a
  //request and the login page says so. no cleanup here (this provider has no scope and the manager has no database):
  //the courier layout unmounts through RequireRole and stops its worker, the same path as a logout made in another tab,
  //and the next courier start sweeps what the server already holds
  useEffect(() => {
    if (!user) return;
    return watchTokenExpiry(() => logout({ reason: "expired" }));
  }, [user]);

  async function login(username: string, password: string) {
    const res = await post("/auth/login", { username, password });
    const u = normalizeUser(res.user);
    localStorage.setItem(TOKEN_KEY, res.token);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    setUser(u);
    return u;
  }

  //`end` is the note for the login page (what was sent before a logout, or that the token expired)
  function logout(end?: SessionEnd) {
    clearSession(end);
    setUser(null);
  }

  return <Ctx.Provider value={{ user, login, logout }}>{children}</Ctx.Provider>;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the server now returns user.id next to the jwt's sub, but a session stored before that change has only sub. the offline
//data layer keys everything by user.id, so fill it here once instead of teaching every reader about both names
function normalizeUser(u: any): IUser | null {
  if (!u) return null;
  return { ...u, id: u.id ?? u.sub };
}

/*──────────────────────────────────────────────────────────────────────────*/

export function useAuth() {
  return useContext(Ctx);
}

/*──────────────────────────────────────────────────────────────────────────*/

export function homeOf(user: IUser) {
  return user?.role === UserRole.courier ? "/courier" : "/manager/issuances";
}
