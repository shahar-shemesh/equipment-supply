import { createContext, useContext, useEffect, useState } from "react";

import { AuthMode, IAuthUser, UserRole } from "../../../shared/@core";
import { hasRole } from "../../../shared/auth";
import { authProviderFor, SignInInput } from "../auth/provider";
import { clearSession, get, SessionEnd, TOKEN_KEY, USER_KEY } from "./service";
import { watchTokenExpiry } from "../courier/offline/identity";

//the session on the client: a jwt and the IAuthUser the server answered with, both in localStorage. which login the page
//offers is the server's call (GET /api/auth/mode), the provider in auth/provider.ts does the sign in for that mode, and
//the roles are read as given, never derived here
type AuthCtx = {
  user: IAuthUser | null;
  mode: AuthMode | null; //null while the mode request is in flight, or when it failed
  modeError: boolean; //the mode request failed: the server is unreachable (or answered something else)
  signIn: (input: SignInInput) => Promise<IAuthUser>;
  logout: (end?: SessionEnd) => void;
  //the identity behind the token as the server holds it now (GET /api/auth/me): the stored user follows a courier row
  //linked or unlinked since the login, the token stays. resolves with what is stored afterwards, null without a session
  refreshIdentity: () => Promise<IAuthUser | null>;
};

const Ctx = createContext<AuthCtx>(null);
const MODE_RETRY_MS = 15_000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<IAuthUser | null>(() => readStoredUser(true));
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [modeError, setModeError] = useState(false);

  //asked once, at mount: the mode is a property of the server, not of this build. a failed request is tried again when
  //the network comes back, so a login page opened offline recovers without a reload
  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    function ask() {
      if (retry) clearTimeout(retry);
      retry = null;
      get("/auth/mode")
        .then((r) => {
          if (!alive) return;
          if (r?.mode === AuthMode.mock || r?.mode === AuthMode.cognito) {
            setMode(r.mode);
            setModeError(false);
          } else failed();
        })
        .catch(() => alive && failed());
    }
    //a server that is down while the browser is online fires no event: the page asks again by itself
    function failed() {
      setModeError(true);
      retry = setTimeout(ask, MODE_RETRY_MS);
    }
    ask();
    window.addEventListener("online", ask);
    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
      window.removeEventListener("online", ask);
    };
  }, []);

  //a login or logout in another tab of the same browser: this tab follows it instead of staying on the old account with
  //the new account's token in storage (the courier screens restart their sync worker when the user changes)
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== USER_KEY && e.key !== null) return;
      setUser(readStoredUser(false));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  //the identity is asked for at the start (the app opened, a tab reloaded) and when the network returns: a courier row
  //linked or unlinked while the tablet was away shows without a new sign in. offline the login's snapshot stands
  useEffect(() => {
    if (!user) return;
    const ask = () => {
      refreshIdentity().catch(() => {});
    };
    if (navigator.onLine) ask();
    window.addEventListener("online", ask);
    return () => window.removeEventListener("online", ask);
  }, [user?.id]);

  //the client side end of the 12 hour token: at exp, or on the first focus after it, the session is gone without a
  //request and the login page says so. no cleanup here (this provider has no scope and the manager has no database):
  //the courier layout unmounts through RequireRole and stops its worker, the same path as a logout made in another tab,
  //and the next courier start sweeps what the server already holds
  useEffect(() => {
    if (!user) return;
    return watchTokenExpiry(() => logout({ reason: "expired" }));
  }, [user]);

  //the provider of the running mode answers { token, user }; both are stored as given. without a known mode there is
  //nothing to sign in against (the login page shows no button then), so this is a programming error, not a user one
  async function signIn(input: SignInInput) {
    if (!mode) throw new Error("auth mode is not known yet");
    const res = await authProviderFor(mode).signIn(input);
    if (typeof res?.token !== "string" || !isSession(res.user)) throw new Error("sign in answer is not a session");
    localStorage.setItem(TOKEN_KEY, res.token);
    localStorage.setItem(USER_KEY, JSON.stringify(res.user));
    setUser(res.user);
    return res.user;
  }

  //`end` is the note for the login page (what was sent before a logout, or that the token expired)
  function logout(end?: SessionEnd) {
    clearSession(end);
    setUser(null);
  }

  //what the server says the account is now. a changed answer replaces the stored user, so the offline scope (users.id +
  //couriers.id, identity.ts) follows the row and the courier shell restarts its worker under the new one. a failed
  //request rejects and writes nothing (offline, the snapshot of the login is the best there is; the callers decide);
  //a 401 on the way is the interceptor's, the session ends there. the answer is written only for the session that
  //asked: a logout, an expiry or another tab's sign in while the request was out leaves whatever they wrote alone, and
  //an answer for another account or one that is not a session is ignored
  async function refreshIdentity(): Promise<IAuthUser | null> {
    const stored = readStoredUser(false);
    if (!stored) return null;
    const me: any = await get("/auth/me");
    const current = readStoredUser(false);
    if (!current || current.id !== stored.id) return current;
    if (!isSession(me) || me.id !== current.id) return current;
    const next: IAuthUser = { id: me.id, username: me.username, name: me.name, email: me.email ?? null, roles: me.roles, courier_id: me.courier_id ?? null };
    if (JSON.stringify(next) === JSON.stringify({ ...current, email: current.email ?? null, courier_id: current.courier_id ?? null })) return current;
    localStorage.setItem(USER_KEY, JSON.stringify(next));
    setUser(next);
    return next;
  }

  return <Ctx.Provider value={{ user, mode, modeError, signIn, logout, refreshIdentity }}>{children}</Ctx.Provider>;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the stored user, or null. a session stored before the roles existed (one `role`, no `roles` array, the old jwt behind
//it) is not a session: the guards read the array and the mock provider refuses a token without it, so the person
//signs in again. `drop` removes such a leftover with its token, at mount only: the storage event path leaves the
//other tab's write alone
function readStoredUser(drop: boolean): IAuthUser | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(USER_KEY);
    const u = JSON.parse(raw || "null");
    if (isSession(u)) return u;
  } catch (e) {
    //junk in storage reads as no session
  }
  if (drop && raw) clearSession();
  return null;
}

/*──────────────────────────────────────────────────────────────────────────*/

//an id and at least one role the routes know. a list with neither would send the guards in circles between the two
//homes (homeOf says /courier, the courier tree says homeOf), so it is not a session at all
function isSession(u: any): u is IAuthUser {
  return !!u && typeof u === "object" && u.id != null && Array.isArray(u.roles) && u.roles.some((r: any) => r === UserRole.manager || r === UserRole.courier);
}

/*──────────────────────────────────────────────────────────────────────────*/

export function useAuth() {
  return useContext(Ctx);
}

/*──────────────────────────────────────────────────────────────────────────*/

//where a signed in person lands: a manager (who holds the courier role too) on the board, everyone else on the courier
//screens
export function homeOf(user: IAuthUser | null | undefined) {
  return hasRole(user, UserRole.manager) ? "/manager/issuances" : "/courier";
}
