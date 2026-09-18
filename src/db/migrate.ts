/** Apply migrations, sync the tool catalog, and backfill worker grants on top-level agents. */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isNull } from "drizzle-orm";
import { migrate as runMigrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig, type Config } from "../config.js";
import { syncTools } from "../tools/sync.js";
import { agents } from "./schema.js";
import { applyWorkerCatalog } from "./seed.js";
import { createDb } from "./client.js";

export async function migrate(config: Config): Promise<void> {
  const { client, db } = createDb(config.env.databaseUrl);
  try {
    await runMigrate(db, { migrationsFolder: join(config.serviceRoot, "drizzle") });
    await syncTools(db);
    const tops = await db
      .select({ id: agents.id })
      .from(agents)
      .where(isNull(agents.parentAgentId));
    for (const row of tops) {
      await applyWorkerCatalog(db, row.id);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate(loadConfig());
}
