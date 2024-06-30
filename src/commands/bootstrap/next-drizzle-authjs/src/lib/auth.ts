import NextAuth from 'next-auth';
import Passkey from 'next-auth/providers/passkey';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/lib/db';
import * as schema from '@/lib/schema';

export const { handlers, signIn, signOut, auth } = NextAuth({
  basePath: '/auth',
  providers: [Passkey],
  experimental: { enableWebAuthn: true },
  adapter: DrizzleAdapter(db, {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
    authenticatorsTable: schema.authenticators,
  }),
});
