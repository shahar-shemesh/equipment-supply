import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthMode, MockIdentity } from "../../../shared/@core";
import { authProviderFor, cognitoAuthProvider, mockAuthProvider } from "./provider";

//the client side of the auth boundary: the mock provider sends the identity key and nothing else, the cognito one
//refuses with the pointer to the doc, and the factory picks by the mode the server answered

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../utils/service", () => ({ post: mocks.post }));

beforeEach(() => {
  mocks.post.mockReset();
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("auth providers", () => {
  it("mock posts only the identity to /auth/mock/login and hands the answer back as is", async () => {
    const answer = { token: "t", user: { id: 1, username: "manager", name: "דנה לוי", email: null, roles: ["manager", "courier"], courier_id: 6 } };
    mocks.post.mockResolvedValue(answer);
    //whatever else a caller puts on the input stays on this side: the server resolves everything from the key
    const res = await mockAuthProvider.signIn({ identity: MockIdentity.manager, password: "never" } as any);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith("/auth/mock/login", { identity: "manager" });
    expect(res).toBe(answer);
    expect(mockAuthProvider.mode).toBe(AuthMode.mock);
  });

  it("cognito rejects every sign in with the pointer to docs/auth.md and sends nothing", async () => {
    await expect(cognitoAuthProvider.signIn({ identity: MockIdentity.courier })).rejects.toThrow(/cognito sign in is not wired yet.*docs\/auth\.md/);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(cognitoAuthProvider.mode).toBe(AuthMode.cognito);
  });

  it("the factory picks the provider of the mode", () => {
    expect(authProviderFor(AuthMode.mock)).toBe(mockAuthProvider);
    expect(authProviderFor(AuthMode.cognito)).toBe(cognitoAuthProvider);
  });
});
