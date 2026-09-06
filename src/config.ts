/** Typed process config. The only module that reads the environment or config.toml. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tomlPath = join(serviceRoot, "config.toml");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

const fileSchema = z.object({
  runtime: z.object({
    lane_queue_timeout_ms: z.number().int().positive(),
  }),
  dwar: z.object({
    timeout_ms: z.number().int().positive(),
    retry_attempts: z.number().int().positive(),
    backoff_ms: z.array(z.number().min(0)).nonempty(),
  }),
  yaad: z.object({
    timeout_ms: z.number().int().positive(),
    retry_attempts: z.number().int().positive(),
    backoff_ms: z.array(z.number().min(0)).nonempty(),
  }),
});

export type FileConfig = z.infer<typeof fileSchema>;

export type Config = {
  serviceRoot: string;
  env: {
    databaseUrl: string;
    logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  };
  runtime: FileConfig["runtime"];
  dwar: FileConfig["dwar"];
  yaad: FileConfig["yaad"];
};

export function loadFileConfig(): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(tomlPath, "utf8");
  } catch {
    throw new Error(`missing config file: ${tomlPath}`);
  }
  const parsed = fileSchema.safeParse(parseToml(raw));
  if (!parsed.success) {
    throw new Error(`invalid config.toml: ${parsed.error.message}`);
  }
  return parsed.data;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) {
    return cached;
  }
  const file = loadFileConfig();
  const envParsed = envSchema.safeParse(process.env);
  if (!envParsed.success) {
    const parts = envParsed.error.issues.map((issue) => {
      const loc = issue.path.join(".");
      return loc ? `${loc}: ${issue.message}` : issue.message;
    });
    throw new Error(`invalid environment: ${parts.join("; ")}`);
  }
  const env = envParsed.data;
  cached = {
    serviceRoot,
    env: {
      databaseUrl: env.DATABASE_URL,
      logLevel: env.LOG_LEVEL,
    },
    runtime: file.runtime,
    dwar: file.dwar,
    yaad: file.yaad,
  };
  return cached;
}
