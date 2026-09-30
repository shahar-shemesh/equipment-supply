import { IUser } from "../../../../shared/@core";
import { TOKEN_KEY } from "../../utils/service";

//who owns the local data. everything the offline layer stores is keyed by users.id + couriers.id, never by the jwt alone:
//the token expires after 12h, the account does not

export type JwtPayload = { sub: number; courier_id: number | null; exp: number; username: string };

//returns "<user id>:<courier id>", or null when either is missing (a manager, or a session stored before user.id existed).
//every scoped function of the data layer throws on a null scope, so nothing is ever partitioned under "undefined"
export function scopeOf(user: Partial<IUser> | null | undefined): string | null {
  if (user?.id == null || user?.courier_id == null) return null;
  return `${user.id}:${user.courier_id}`;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the payload of a jwt without verifying it (the server verifies, the client only needs sub and exp to decide whether a
//request is worth sending). returns null for anything that is not a three part token with a json payload
export function decodeJwt(token: string | null | undefined): JwtPayload | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const json = decodeURIComponent(Array.from(atob(padded), (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
    const p = JSON.parse(json);
    if (!p || typeof p !== "object") return null;
    return { sub: p.sub, courier_id: p.courier_id ?? null, exp: p.exp, username: p.username };
  } catch (e) {
    return null;
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//the stored token, or null. localStorage itself can throw (storage disabled), that reads as "no token"
export function currentToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (e) {
    return null;
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

//true when the token decodes and its exp is still ahead of `now` (ms). no clock skew allowance on purpose: a token the
//device thinks is fresh but the server rejects lands in the auth state through the normal 401 path
export function tokenIsFresh(token: string | null | undefined, now = Date.now()): boolean {
  const p = decodeJwt(token);
  return !!p && typeof p.exp === "number" && p.exp * 1000 > now;
}

/*──────────────────────────────────────────────────────────────────────────*/

//service workers, crypto.randomUUID, web locks and navigator.storage.persist only exist on https or localhost. a tablet
//opening http://<lan-ip>:5173 gets none of them, the status bar says so and the fallbacks below kick in
export function isSecureContext(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true;
}

/*──────────────────────────────────────────────────────────────────────────*/

//true when the stored token belongs to the account the scope was made for. every background read of a scope checks it:
//another courier signed in on this device (a second tab still shows the first one) must never refresh the first
//courier's snapshot with their own list, the worker makes the same check before sending a report
export function tokenMatchesScope(scope: string | null | undefined, token: string | null | undefined = currentToken()): boolean {
  const p = decodeJwt(token);
  if (!p || !scope) return false;
  const [userId, courierId] = scope.split(":");
  return String(p.sub) === userId && String(p.courier_id ?? "") === courierId;
}
