import { drizzle } from "drizzle-orm/d1";

import { schema } from "./schema";

export function createDatabase(env: Env) {
  return drizzle(env.DB, { schema });
}

export type Database = ReturnType<typeof createDatabase>;
