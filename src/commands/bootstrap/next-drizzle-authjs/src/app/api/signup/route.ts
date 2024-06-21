import { v4 } from "uuid";
import { db } from "@/lib/db";
import * as schema from "@/lib/schema";
import { saltAndHashPassword } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(request: Request): Promise<Response> {
  const formData = await request.formData();
  const email = formData.get("email");
  const password = formData.get("password");
  const name = formData.get("name");
  if (
    typeof password !== "string" ||
    password.length < 6 ||
    password.length > 255 ||
    typeof email !== "string" ||
    typeof name !== "string"
  ) {
    return new Response("Invalid password", {
      status: 400,
    });
  }

  const userId = v4();
  const saltAndHash = saltAndHashPassword(password);

  await db.insert(schema.users).values({
    id: userId,
    name,
    email,
  });

  await db.insert(schema.passwords).values({
    userId,
    password: saltAndHash.hash,
    salt: saltAndHash.salt,
    iterations: saltAndHash.iterations,
  });

  return NextResponse.redirect(new URL("/", request.url));
}
