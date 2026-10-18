import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { User } from '../entities';
import { MockAuthProvider } from '../auth/mock/mock-auth.provider';

//a token for a user the fixture inserted, signed by the app's own mock provider. the specs test the routes, not the
//login, and their users (m, c, c2...) are not the two mock identities; auth.e2e.spec covers the login route itself.
//the courier row, when the user has one, must exist before the call: the token carries its id. writes the auth_login
//audit row like the login route does, so the audit counts read the same either way
export async function tokenFor(app: INestApplication, username: string): Promise<string> {
    const user = await app.get(DataSource).getRepository(User).findOneOrFail({ where: { username } });
    return (await app.get(MockAuthProvider).issueFor(user)).token;
}
