import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

/** Doctor and legacy imports own normalization; runtime reads use indexed equality. */
export function repairLegacyTaskIdentifiers(db: DatabaseSync): void {
  if (!tableExists(db, "task_runs")) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    const queries = getNodeSqliteKysely<DB>(db);
    const tasks = executeSqliteQuerySync(
      db,
      queries.selectFrom("task_runs").select(["task_id", "run_id", "child_session_key"]),
    ).rows;
    const changed = tasks.filter(
      (task) =>
        task.run_id !== (normalizeOptionalString(task.run_id) ?? null) ||
        task.child_session_key !== (normalizeOptionalString(task.child_session_key) ?? null),
    );
    if (changed.length === 0) {
      return;
    }
    const runs = new Map<string, (typeof tasks)[number]>();
    const changedRunIds = new Set(
      changed
        .filter((task) => task.run_id !== (normalizeOptionalString(task.run_id) ?? null))
        .map((task) => task.run_id),
    );
    const changedChildKeys = new Set(
      changed.map((task) => normalizeOptionalString(task.child_session_key)),
    );
    for (const task of tasks) {
      const key = normalizeOptionalString(task.run_id);
      if (!key) {
        continue;
      }
      const previous = runs.get(key);
      if (previous && previous.run_id !== task.run_id) {
        throw new Error(
          `Cannot normalize task run identifier: tasks ${JSON.stringify(previous.task_id)} and ${JSON.stringify(task.task_id)} have distinct run IDs that become ${JSON.stringify(key)}. Resolve the conflicting bindings before retrying Doctor; no rows were changed.`,
        );
      }
      runs.set(key, task);
    }
    if (tableExists(db, "subagent_runs")) {
      const update = db.prepare(
        "UPDATE subagent_runs SET child_session_key = ?, payload_json = ? WHERE run_id = ?",
      );
      for (const row of iterateSqliteQuerySync(
        db,
        queries.selectFrom("subagent_runs").select(["run_id", "child_session_key", "payload_json"]),
      )) {
        const childKey = normalizeOptionalString(row.child_session_key);
        const nextChildKey =
          childKey && changedChildKeys.has(childKey) ? childKey : row.child_session_key;
        const changeChild = nextChildKey !== row.child_session_key;
        const stored = safeParseJsonRecord(row.payload_json);
        const payload =
          stored &&
          isRecord(stored.parentCompletion) &&
          stored.parentCompletion.completionTarget === "parent"
            ? stored.parentCompletion
            : stored;
        if (!payload) {
          if (changeChild || changedRunIds.has(row.run_id)) {
            throw new Error(
              `Cannot normalize task run identifier for subagent ${JSON.stringify(row.run_id)}: its completion payload is unreadable. Repair that record before retrying Doctor; no rows were changed.`,
            );
          }
          continue;
        }
        const previousRunId = normalizeOptionalString(payload.taskRunId) ?? row.run_id;
        const taskRunId = normalizeOptionalString(previousRunId);
        const task = taskRunId ? runs.get(taskRunId) : undefined;
        if (
          (task && task.run_id !== taskRunId && task.run_id !== previousRunId) ||
          (!taskRunId && changedRunIds.has(previousRunId))
        ) {
          throw new Error(
            `Cannot normalize task run identifier for subagent ${JSON.stringify(row.run_id)}: normalization would change its existing task binding. Resolve the conflicting bindings before retrying Doctor; no rows were changed.`,
          );
        }
        const changeRun = Boolean(task?.run_id === previousRunId && taskRunId !== previousRunId);
        if (!changeRun && !changeChild) {
          continue;
        }
        if (changeRun) {
          // Physical run IDs also own queue entries and receipts. Keep them intact.
          payload.taskRunId = taskRunId;
        }
        if (changeChild) {
          payload.childSessionKey = nextChildKey;
          if (
            isRecord(payload.delivery) &&
            isRecord(payload.delivery.payload) &&
            payload.delivery.payload.childSessionKey === row.child_session_key
          ) {
            payload.delivery.payload.childSessionKey = nextChildKey;
          }
        }
        update.run(nextChildKey, JSON.stringify(stored), row.run_id);
      }
    }
    const update = db.prepare(
      "UPDATE task_runs SET run_id = ?, child_session_key = ? WHERE task_id = ?",
    );
    for (const task of changed) {
      update.run(
        normalizeOptionalString(task.run_id) ?? null,
        normalizeOptionalString(task.child_session_key) ?? null,
        task.task_id,
      );
    }
  });
}
