import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createSessionTranscriptFtsInserter,
  deleteSessionTranscriptFtsRowsInTransaction,
  selectSessionTranscriptFtsRows,
} from "./session-transcript-fts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function fixture() {
  const options = {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make("transcript-fts-") },
  };
  return { options, database: openOpenClawAgentDatabase(options) };
}

it("preserves duplicate message identities and nullable cold rows through indexed deletion and rollback", () => {
  const { options, database } = fixture();
  runOpenClawAgentWriteTransaction(({ db }) => {
    const insert = createSessionTranscriptFtsInserter(db, "session");
    insert({ messageId: "duplicate", text: "first searchable", role: "user", timestamp: 10 });
    insert({
      messageId: "duplicate",
      text: "second searchable",
      role: "assistant",
      timestamp: "10",
    });
    insert({ messageId: null, text: null, role: null, timestamp: null });
    createSessionTranscriptFtsInserter(
      db,
      "other",
    )({
      messageId: "duplicate",
      text: "unrelated searchable",
      role: "user",
      timestamp: 11,
    });
  }, options);
  const read = () =>
    executeSqliteQuerySync(database.db, selectSessionTranscriptFtsRows(database.db, "session"))
      .rows;
  const before = read();
  expect(before).toEqual([
    { message_id: "duplicate", text: "first searchable", role: "user", timestamp: 10 },
    { message_id: "duplicate", text: "second searchable", role: "assistant", timestamp: "10" },
    { message_id: null, text: null, role: null, timestamp: null },
  ]);

  expect(() =>
    runOpenClawAgentWriteTransaction(({ db }) => {
      // Exercise the schema-owned delete independently of the runtime delete helper.
      db.exec(`DELETE FROM session_transcript_fts_rows
        WHERE id = (SELECT MIN(id) FROM session_transcript_fts_rows WHERE session_id = 'session')`);
      expect(read()).toEqual(before.slice(1));
      expect(
        db
          .prepare(
            "SELECT text FROM session_transcript_fts WHERE session_transcript_fts MATCH 'first'",
          )
          .all(),
      ).toEqual([]);
      throw new Error("roll back both projections");
    }, options),
  ).toThrow("roll back both projections");
  expect(read()).toEqual(before);

  runOpenClawAgentWriteTransaction(({ db }) => {
    expect(deleteSessionTranscriptFtsRowsInTransaction(db, "session", { messageIds: [] })).toBe(0);
    expect(
      deleteSessionTranscriptFtsRowsInTransaction(db, "session", { messageIds: ["duplicate"] }),
    ).toBe(2);
    expect(read()).toEqual([before[2]]);
    expect(deleteSessionTranscriptFtsRowsInTransaction(db, "session", { maxRows: 1 })).toBe(1);
    expect(deleteSessionTranscriptFtsRowsInTransaction(db, "session", { maxRows: 1 })).toBe(0);
  }, options);
  expect(database.db.prepare("SELECT session_id, text FROM session_transcript_fts").all()).toEqual([
    { session_id: "other", text: "unrelated searchable" },
  ]);
});

it("allocates FTS identities beyond the JavaScript safe-integer boundary without rounding", () => {
  const { options, database } = fixture();
  runOpenClawAgentWriteTransaction(({ db }) => {
    db.exec(`
      INSERT INTO session_transcript_fts_rows(id, session_id, message_id)
        VALUES (9007199254740992, 'session', 'retained');
      INSERT INTO session_transcript_fts(rowid, session_id, message_id, text, role, timestamp)
        VALUES (9007199254740992, 'session', 'retained', 'old searchable', 'user', 1);
    `);
    createSessionTranscriptFtsInserter(
      db,
      "session",
    )({
      messageId: "appended",
      text: "new searchable",
      role: "assistant",
      timestamp: 1,
    });
  }, options);
  expect(
    database.db
      .prepare(`SELECT CAST(rowid AS TEXT) AS id, message_id
      FROM session_transcript_fts ORDER BY rowid`)
      .all(),
  ).toEqual([
    { id: "9007199254740992", message_id: "retained" },
    { id: "9007199254740993", message_id: "appended" },
  ]);
  runOpenClawAgentWriteTransaction(({ db }) => {
    expect(
      deleteSessionTranscriptFtsRowsInTransaction(db, "session", { messageIds: ["appended"] }),
    ).toBe(1);
  }, options);
  expect(database.db.prepare("SELECT message_id FROM session_transcript_fts").all()).toEqual([
    { message_id: "retained" },
  ]);
});
