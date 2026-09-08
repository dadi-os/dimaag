/** Apply migrations, sync the tool catalog, and seed root Dadi. */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate as runMigrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig, type Config } from "../config.js";
import { syncTools } from "../tools/sync.js";
import { createDb } from "./client.js";
import { seed } from "./seed.js";

export async function migrate(config: Config): Promise<void> {
  const { client, db } = createDb(config.env.databaseUrl);
  try {
    await runMigrate(db, { migrationsFolder: join(config.serviceRoot, "drizzle") });
    await syncTools(db);
    await seed(db, config);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate(loadConfig());
}
