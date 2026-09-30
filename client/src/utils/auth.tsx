import { createContext, useContext, useEffect, useState } from "react";

import { IUser, UserRole } from "../../../shared/@core";
import { post, TOKEN_KEY, USER_KEY } from "./service";

//dev-local auth only: username + password against the seeded accounts. the token is a plain jwt in localStorage.
//when the production identity provider is decided this file is the place that changes on the client side
type AuthCtx = {
  user: IUser | null;
  login: (username: string, password: string) => Promise<IUser>;
  logout: () => void;
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

  async function login(username: string, password: string) {
    const res = await post("/auth/login", { username, password });
    const u = normalizeUser(res.user);
    localStorage.setItem(TOKEN_KEY, res.token);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    setUser(u);
    return u;
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
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
