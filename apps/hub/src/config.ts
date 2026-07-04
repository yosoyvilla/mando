import { z } from "zod";

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  COOKIE_SECRET: z.string().min(1),
  PUBLIC_URL: z.string().url(),
  MANDO_ADMIN_EMAIL: z.string().email().optional(),
  MANDO_ADMIN_PASSWORD: z.string().min(8).optional(),
});

export type Config = {
  port: number;
  databaseUrl: string;
  cookieSecret: string;
  publicUrl: string;
  adminEmail?: string;
  adminPassword?: string;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const p = Schema.parse(env);
  return {
    port: p.PORT,
    databaseUrl: p.DATABASE_URL,
    cookieSecret: p.COOKIE_SECRET,
    publicUrl: p.PUBLIC_URL,
    adminEmail: p.MANDO_ADMIN_EMAIL,
    adminPassword: p.MANDO_ADMIN_PASSWORD,
  };
}
