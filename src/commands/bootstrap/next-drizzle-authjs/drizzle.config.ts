import { defineConfig } from "drizzle-kit";
import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"] });

export default defineConfig({
  schema: "./src/lib/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
