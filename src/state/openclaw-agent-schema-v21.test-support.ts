import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

// Frozen from f69617aa3818d805889692918ee7f51bef666597 before the schema-22 storage cutover.
// Historical migration inputs must not inherit the current runtime's new column definitions.
export const OPENCLAW_AGENT_SCHEMA_V21_SQL = fs.readFileSync(
  new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v21.sql", import.meta.url),
  "utf8",
);

export function seedOpenClawAgentSchemaV21(database: DatabaseSync, agentId = "main"): void {
  database.exec(OPENCLAW_AGENT_SCHEMA_V21_SQL);
  database.exec("PRAGMA user_version = 21");
  database
    .prepare(`INSERT INTO schema_meta
    (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
    VALUES ('primary', 'agent', 21, ?, '2026.9.4', 1, 1)`)
    .run(agentId);
}
