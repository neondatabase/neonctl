import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@/lib/schema";
import { neon } from "@neondatabase/serverless";

const connectionString = `${process.env.DATABASE_URL}`;
const sql = neon(connectionString);
export const db = drizzle(sql, { schema });
