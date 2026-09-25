import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDb } from "./client.js";
import { getConfig } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Apply all pending SQL migrations from apps/api/drizzle. */
export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString, { max: 2 });
  try {
    // dist/db/migrate.js -> ../../drizzle ; src/db/migrate.ts -> ../../drizzle
    const migrationsFolder = path.resolve(here, "../../drizzle");
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await handle.close();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const url = getConfig().DATABASE_URL;
  runMigrations(url)
    .then(() => {
      console.log("Migrations applied");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
