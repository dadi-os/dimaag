import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db, Sql } from "./db/client.js";
import type { DwarClient } from "./dwar/client.js";
import type { YaadClient } from "./yaad/client.js";
import { DimaagError } from "./errors.js";
import { createRuntime, type Runtime } from "./runtime/engine.js";
import { registerV1 } from "./routers/index.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Db;
    sql: Sql;
    dwar: DwarClient;
    yaad: YaadClient;
    runtime: Runtime;
  }
}

export async function buildApp(
  config: Config,
  deps: { db: Db; sql: Sql; dwar: DwarClient; yaad: YaadClient; runtime?: Runtime },
): Promise<FastifyInstance> {
  const app = Fastify({
    disableRequestLogging: true,
    logger: {
      level: config.env.logLevel,
      base: { service: "dimaag" },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
  });
  const runtime =
    deps.runtime ??
    createRuntime({
      db: deps.db,
      dwar: deps.dwar,
      yaad: deps.yaad,
      config,
      log: app.log,
    });
  app.decorate("config", config);
  app.decorate("db", deps.db);
  app.decorate("sql", deps.sql);
  app.decorate("dwar", deps.dwar);
  app.decorate("yaad", deps.yaad);
  app.decorate("runtime", runtime);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof DimaagError) {
      return reply.status(err.statusCode).send({
        error: { type: err.type, message: err.message },
      });
    }
    const statusCode =
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof err.statusCode === "number"
        ? err.statusCode
        : 500;
    const message = err instanceof Error ? err.message : "internal error";
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { type: "invalid_request", message },
      });
    }
    request.log.error(err);
    return reply.status(500).send({
      error: { type: "internal", message: "internal error" },
    });
  });

  app.get("/health", async () => ({ status: "ok" }));
  await app.register(registerV1);
  return app;
}
