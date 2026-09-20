import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import type { AliasedExpression } from "kysely";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "./kysely-sync.js";

export class SqliteJsonlReadBudgetExceededError extends Error {}

/** Admit a filtered JSONL source inside the caller's payload-read transaction. */
export function assertSqliteJsonlReadBudget(
  database: DatabaseSync,
  source: AliasedExpression<
    { event_json: string | null; event_utf8_bytes?: number | null },
    "events"
  >,
  budget: number,
  label: string,
  options: { hasExactUtf8Bytes?: boolean; separatorBytes?: number } = {},
): void {
  const db = getNodeSqliteKysely<{ pragma_encoding: { encoding: string } }>(database);
  const encoding = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("pragma_encoding").select("encoding"),
  )?.encoding;
  const utf8 = encoding === "UTF-8";
  const rejectOverflow = (bytes: number) => {
    if (bytes > budget) {
      throw new SqliteJsonlReadBudgetExceededError(
        `${label} is too large to export (at least ${bytes} bytes; limit ${budget})`,
      );
    }
  };

  // Keep this source an unbounded filtered SELECT: SQLite flattens it so
  // octet_length reads column metadata without decoding overflow payloads.
  // UTF-16 stored bytes / 2 is a UTF-8 lower bound, rejecting huge rows first.
  const sizes = iterateSqliteQuerySync(
    database,
    db
      .selectFrom(source)
      .select((eb) => [
        eb.fn<number | null>("octet_length", ["event_json"]).as("bytes"),
        (options.hasExactUtf8Bytes ? eb.ref("event_utf8_bytes") : eb.val(null)).as("utf8_bytes"),
      ]),
  );
  let bytes = 0;
  let separator = 0;
  let knownBytes = 0;
  let separators = 0;
  let unknownRows = 0;
  for (const row of sizes) {
    const exact = row.utf8_bytes ?? (utf8 ? row.bytes : null);
    if (exact === null && row.bytes === null) {
      throw new Error(`${label} has a transcript row without byte metadata or identity text`);
    }
    if (exact !== null) {
      knownBytes += exact;
    } else {
      unknownRows += 1;
    }
    bytes += (exact ?? Math.ceil(row.bytes! / 2)) + separator;
    separators += separator;
    rejectOverflow(bytes);
    separator = options.separatorBytes ?? 1;
  }
  if (unknownRows === 0) {
    return;
  }

  // UTF-16 storage size is not the UTF-8 export size. After metadata admission,
  // decode one bounded row at a time for exact accounting in the same snapshot.
  bytes = knownBytes + separators;
  const unknown = db
    .selectFrom(source)
    .select("event_json")
    .$if(options.hasExactUtf8Bytes === true, (query) =>
      query.where("event_utf8_bytes", "is", null),
    );
  for (const row of iterateSqliteQuerySync(database, unknown)) {
    if (row.event_json === null) {
      throw new Error(`${label} has a transcript row without identity text`);
    }
    bytes += Buffer.byteLength(row.event_json, "utf8");
    rejectOverflow(bytes);
  }
}
