import { sql, type RawBuilder } from "kysely";
import { transcriptEventUtf8BytesSql } from "./transcript-payload.js";

/** Preserve native identity accounting where a legacy row has no exact UTF-8 size. */
export function transcriptEventReadBytesSql(alias = "transcript_events"): RawBuilder<number> {
  /* kysely-allow-raw: compressed rows use recorded uncompressed bytes; identity fallback reads native column metadata. */
  return sql<number>`coalesce(${transcriptEventUtf8BytesSql(alias)}, octet_length(${sql.ref(`${alias}.event_json`)}))`;
}
