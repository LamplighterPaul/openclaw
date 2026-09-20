import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";

// These schema-21 definitions remain migration input until the schema-22
// converters finish. Earlier structural/media migrations still write TEXT.
const LEGACY_STORAGE_TABLES = {
  transcript_events: `CREATE TABLE IF NOT EXISTS transcript_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES "session_windows"(session_id) ON DELETE CASCADE
) STRICT;`,
  memory_index_chunks: `CREATE TABLE IF NOT EXISTS memory_index_chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;`,
  memory_embedding_cache: `CREATE TABLE IF NOT EXISTS memory_embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  dims INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
) STRICT;`,
};

/** Preserve historical storage contracts before the admitted schema-22 cutover. */
export function withLegacyAgentStorageSchema(schema: string): string {
  for (const [table, legacySchema] of Object.entries(LEGACY_STORAGE_TABLES)) {
    schema = schema.replace(extractSqliteTableSchema(schema, table), legacySchema);
  }
  if (schema.includes("CREATE TABLE IF NOT EXISTS session_transcript_fts_rows (")) {
    schema = schema.replace(
      extractSqliteTableSchema(schema, "session_transcript_fts_rows", {
        endMarker: "INSERT OR IGNORE INTO memory_index_state",
        includeEndMarker: false,
      }),
      "",
    );
  }
  return schema;
}
