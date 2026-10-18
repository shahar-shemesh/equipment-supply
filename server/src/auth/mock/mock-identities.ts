import { MockIdentity, UserRole } from '../../../../shared/@core';

export type MockIdentityDef = { key: MockIdentity; username: string; name: string; email: string; role: UserRole };

//the two buttons of the login page in mock mode. key is what the client sends, username the seeded users row the server
//resolves it to (seed/seed.data.ts); name, email and role are what the identity provider would say about the person and
//are pinned to the seeded row by mock-identities.spec. roles are never listed here: rolesOf(users.role) derives them
export const MOCK_IDENTITIES: MockIdentityDef[] = [
  { key: MockIdentity.manager, username: 'manager', name: 'דנה לוי', email: 'manager@equipment.local', role: UserRole.manager },
  { key: MockIdentity.courier, username: 'courier1', name: 'יוסי אברהם', email: 'courier1@equipment.local', role: UserRole.courier },
];

export function mockIdentity(key: MockIdentity): MockIdentityDef | null {
  return MOCK_IDENTITIES.find((i) => i.key === key) ?? null;
}
