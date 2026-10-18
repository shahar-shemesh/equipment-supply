import { AuthMode, IAuthUser, MockIdentity } from "../../../shared/@core";
import { post } from "../utils/service";

//the client side of the auth boundary. the server says which mode it runs (GET /api/auth/mode, read in utils/auth.tsx)
//and the matching provider here turns a sign in into { token, user }. what the token means, who the user is and which
//roles they hold is the server's answer, nothing is derived on this side

export type SignInInput = { identity: MockIdentity };

export type ClientAuthProvider = {
  mode: AuthMode;
  signIn: (input: SignInInput) => Promise<{ token: string; user: IAuthUser }>;
};

//AUTH_MODE=mock: the two buttons of the login page. only the identity key goes out, the server maps it to a users row
export const mockAuthProvider: ClientAuthProvider = {
  mode: AuthMode.mock,
  signIn: ({ identity }) => post("/auth/mock/login", { identity }),
};

/*──────────────────────────────────────────────────────────────────────────*/

//AUTH_MODE=cognito: the boundary for the real identity provider. the hosted ui / pkce flow is not written yet, so a sign
//in fails with the pointer to the doc instead of pretending; the login page shows the same message and no button
export const cognitoAuthProvider: ClientAuthProvider = {
  mode: AuthMode.cognito,
  signIn: async () => {
    throw new Error("cognito sign in is not wired yet, see docs/auth.md");
  },
};

/*──────────────────────────────────────────────────────────────────────────*/

export function authProviderFor(mode: AuthMode): ClientAuthProvider {
  return mode === AuthMode.cognito ? cognitoAuthProvider : mockAuthProvider;
}
