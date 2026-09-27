import { createContext, useContext, useState } from "react";

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
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch (e) {
      return null;
    }
  });

  async function login(username: string, password: string) {
    const res = await post("/auth/login", { username, password });
    localStorage.setItem(TOKEN_KEY, res.token);
    localStorage.setItem(USER_KEY, JSON.stringify(res.user));
    setUser(res.user);
    return res.user as IUser;
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }

  return <Ctx.Provider value={{ user, login, logout }}>{children}</Ctx.Provider>;
}

/*──────────────────────────────────────────────────────────────────────────*/

export function useAuth() {
  return useContext(Ctx);
}

/*──────────────────────────────────────────────────────────────────────────*/

export function homeOf(user: IUser) {
  return user?.role === UserRole.courier ? "/courier" : "/manager/issuances";
}
