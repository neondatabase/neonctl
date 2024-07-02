import NextAuth, { AuthError } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import crypto from "crypto";
import { db } from "@/lib/db";
import * as schema from "@/lib/schema";
import { eq } from "drizzle-orm";
import { User } from "@/lib/schema";

export const PBKDF2_KEYLEN = 128;

export function saltAndHashPassword(password: string) {
  const salt = crypto.randomBytes(128).toString("base64");
  const pbkdf2Iterations = 1000;
  const hash = crypto.pbkdf2Sync(
    password,
    salt,
    pbkdf2Iterations,
    PBKDF2_KEYLEN,
    "sha256"
  );

  return {
    salt: salt,
    hash: hash.toString("base64"),
    iterations: pbkdf2Iterations,
  };
}

function isPasswordCorrect(
  savedHash: string,
  savedSalt: string,
  savedIterations: number,
  passwordAttempt: string
) {
  return (
    savedHash ==
    crypto
      .pbkdf2Sync(
        passwordAttempt,
        savedSalt,
        savedIterations,
        PBKDF2_KEYLEN,
        "sha256"
      )
      .toString("base64")
  );
}

async function getUserFromDb(
  email: string,
  passwordAttempt: string
): Promise<User> {
  const users = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email));
  if (!users || users.length === 0) {
    throw new Error(`User with email "${email}" not found`);
  } else if (users.length > 1) {
    throw new Error(`Multiple users with email "${email}" found`);
  }

  const user = users[0];

  const passwords = await db
    .select()
    .from(schema.passwords)
    .where(eq(schema.passwords.userId, user.id));
  if (!passwords || passwords.length === 0) {
    throw new Error(`Password for user with id "${user.id}" not found`);
  } else if (passwords.length > 1) {
    throw new Error(`Multiple passwords for user with id "${user.id}" found`);
  }
  const password = passwords[0];

  if (
    isPasswordCorrect(
      password.password,
      password.salt,
      password.iterations,
      passwordAttempt
    )
  ) {
    return user;
  } else {
    throw new Error("Incorrect password");
  }
}

// See https://github.com/nextauthjs/next-auth/issues/9900.
class InvalidCredentials extends AuthError {
  public readonly kind = "signIn";

  constructor() {
    super("Invalid credentials");
    this.type = "CredentialsSignin";
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  basePath: "/auth",
  providers: [
    Credentials({
      // You can specify which fields should be submitted, by adding keys to the `credentials` object.
      // e.g. domain, username, password, 2FA token, etc.
      credentials: {
        email: { label: "Email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        if (typeof credentials.email !== "string") {
          throw new InvalidCredentials();
        }

        if (typeof credentials.password !== "string") {
          throw new InvalidCredentials();
        }

        // logic to verify if user exists
        let user;
        try {
          user = await getUserFromDb(credentials.email, credentials.password);
        } catch (err: unknown) {
          throw new InvalidCredentials();
        }

        // return user object with the their profile data
        return user;
      },
    }),
  ],
});
