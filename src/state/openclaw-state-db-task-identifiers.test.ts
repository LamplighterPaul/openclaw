import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { upsertSubagentRunRowInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import {
  bindSubagentRunRecord,
  readSubagentRun,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { createStateSchemaMigrationStep } from "../infra/state-migrations.state-schema.js";
import {
  migrateLegacyTaskStateSidecars,
  resolveLegacyTaskRunsSidecarPath,
} from "../infra/state-migrations.storage.js";
import { readTaskRecord } from "../tasks/task-registry.store.kernel.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchemaIfNeeded,
} from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

function seedTask(db: DatabaseSync, taskId: string, runId: string, childSessionKey: string) {
  db.prepare(`INSERT INTO task_runs (
    task_id, runtime, owner_key, requester_session_key, scope_kind, task, status,
    delivery_status, notify_policy, created_at, run_id, child_session_key
  ) VALUES (?, 'subagent', 'agent:main:main', 'agent:main:main', 'session',
    'Preserve completion ownership', 'running', 'pending', 'silent', 100, ?, ?)`).run(
    taskId,
    runId,
    childSessionKey,
  );
  db.prepare(
    "INSERT INTO task_delivery_state (task_id, last_notified_event_at) VALUES (?, 90)",
  ).run(taskId);
}

function seedRun(db: DatabaseSync, privateCompletion: boolean) {
  const run: SubagentRunRecord = {
    runId: " \trun-one\n",
    childSessionKey: "\u00a0agent:main:subagent:one\u00a0",
    requesterSessionKey: "agent:main:main",
    task: "Preserve completion ownership",
    cleanup: "keep",
    createdAt: 100,
    execution: { status: "terminal", endedAt: 200, outcome: { status: "ok" } },
    completion: { required: true, resultText: "result" },
    delivery: { status: "pending", attemptCount: 2, lastError: "retry later" },
    ...(privateCompletion ? { completionTarget: "parent" as const } : {}),
  };
  upsertSubagentRunRowInDatabase({ db, path: ":memory:" }, bindSubagentRunRecord(run));
  return run;
}

function snapshot(db: DatabaseSync) {
  return {
    tasks: db.prepare("SELECT * FROM task_runs ORDER BY task_id").all(),
    delivery: db.prepare("SELECT * FROM task_delivery_state ORDER BY task_id").all(),
    subagents: db.prepare("SELECT * FROM subagent_runs ORDER BY run_id").all(),
  };
}

it.each([false, true])(
  "Doctor repairs task identifiers and the existing implicit completion link (private=%s)",
  async (privateCompletion) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawStateDatabase({ env: state.env });
      const run = seedRun(database.db, privateCompletion);
      seedTask(database.db, "task-one", run.runId, run.childSessionKey);
      seedTask(database.db, "task-duplicate", run.runId, run.childSessionKey);
      seedTask(database.db, "task-empty", " \t\n", "\u00a0");
      const before = snapshot(database.db);
      const pathname = database.path;
      closeOpenClawStateDatabaseForTest();

      expect(repairOpenClawStateDatabaseSchemaIfNeeded({ env: state.env }).warnings).toEqual([]);
      const unchanged = new DatabaseSync(pathname);
      expect(snapshot(unchanged)).toEqual(before);
      unchanged.close();

      const doctor = createStateSchemaMigrationStep({
        stateDir: state.stateDir,
        env: state.env,
        mode: "doctor",
        requiredness: "required",
      });
      expect((await doctor.run()).warnings).toEqual([]);
      const repaired = new DatabaseSync(pathname);
      try {
        const task = readTaskRecord(repaired, "task-one");
        expect(task).toMatchObject({
          runId: "run-one",
          childSessionKey: "agent:main:subagent:one",
        });
        expect(readTaskRecord(repaired, "task-duplicate")).toMatchObject({
          runId: task?.runId,
          childSessionKey: task?.childSessionKey,
        });
        expect(readTaskRecord(repaired, "task-empty")?.runId).toBeUndefined();
        expect(readTaskRecord(repaired, "task-empty")?.childSessionKey).toBeUndefined();
        expect(readSubagentRun({ db: repaired, path: pathname }, run.runId)).toEqual({
          ...run,
          taskRunId: "run-one",
          childSessionKey: "agent:main:subagent:one",
        });
        expect(snapshot(repaired).delivery).toEqual(before.delivery);
        const after = snapshot(repaired);
        repaired.close();
        expect((await doctor.run()).warnings).toEqual([]);
        const repeated = new DatabaseSync(pathname);
        try {
          expect(snapshot(repeated)).toEqual(after);
        } finally {
          repeated.close();
        }
      } finally {
        if (repaired.isOpen) repaired.close();
      }
    });
  },
);

it.each(["task", "completion", "padded completion"])(
  "Doctor refuses a distinct %s run identity collision without changing any task state",
  async (conflict) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawStateDatabase({ env: state.env });
      const run = seedRun(database.db, false);
      seedTask(database.db, "task-one", run.runId, run.childSessionKey);
      if (conflict === "task") {
        seedTask(database.db, "task-conflict", "run-one", "agent:main:subagent:other");
      } else {
        upsertSubagentRunRowInDatabase(
          database,
          bindSubagentRunRecord({
            ...run,
            runId: "unrelated-physical-run",
            taskRunId: "run-one",
          }),
        );
        if (conflict === "padded completion") {
          database.db
            .prepare(
              "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.taskRunId', ?) WHERE run_id = ?",
            )
            .run(run.runId, "unrelated-physical-run");
        }
        // The reader normalizes explicit links before comparing them with a task's run ID.
        expect(readSubagentRun(database, "unrelated-physical-run")?.taskRunId).toBe("run-one");
        expect(readTaskRecord(database.db, "task-one")?.runId).toBe(run.runId);
      }
      const before = snapshot(database.db);
      const pathname = database.path;
      closeOpenClawStateDatabaseForTest();
      const result = await createStateSchemaMigrationStep({
        stateDir: state.stateDir,
        env: state.env,
        mode: "doctor",
        requiredness: "required",
      }).run();
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([expect.stringContaining("task run identifier")]);
      const preserved = new DatabaseSync(pathname);
      try {
        expect(snapshot(preserved)).toEqual(before);
      } finally {
        preserved.close();
      }
    });
  },
);

it("repairs a child key without attaching an unrelated physical run to an unchanged task run ID", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawStateDatabase({ env: state.env });
    const run = seedRun(database.db, false);
    seedTask(database.db, "task-one", "run-one", run.childSessionKey);
    const pathname = database.path;
    closeOpenClawStateDatabaseForTest();
    const result = await createStateSchemaMigrationStep({
      stateDir: state.stateDir,
      env: state.env,
      mode: "doctor",
      requiredness: "required",
    }).run();
    expect(result.warnings).toEqual([]);
    const repaired = new DatabaseSync(pathname);
    try {
      const restored = readSubagentRun({ db: repaired, path: pathname }, run.runId);
      expect(restored?.runId).toBe(run.runId);
      expect(restored?.taskRunId).toBeUndefined();
      expect(readTaskRecord(repaired, "task-one")).toMatchObject({
        runId: "run-one",
        childSessionKey: "agent:main:subagent:one",
      });
    } finally {
      repaired.close();
    }
  });
});

it.each([false, true])(
  "normalizes legacy sidecar imports atomically (conflict=%s)",
  async (conflict) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      fs.mkdirSync(state.statePath("tasks"), { recursive: true });
      const sourcePath = resolveLegacyTaskRunsSidecarPath(state.stateDir);
      const legacy = new DatabaseSync(sourcePath);
      legacy.exec(OPENCLAW_STATE_SCHEMA_SQL);
      seedTask(legacy, "task-one", " run-one ", " agent:main:subagent:one ");
      seedTask(legacy, "task-two", conflict ? "run-one" : " run-one ", " agent:main:subagent:one ");
      legacy.close();
      const result = await migrateLegacyTaskStateSidecars({ stateDir: state.stateDir });
      const database = openOpenClawStateDatabase({ env: state.env });
      if (conflict) {
        expect(result.warnings).toEqual([expect.stringContaining("task run identifier")]);
        expect(snapshot(database.db).tasks).toEqual([]);
        expect(fs.existsSync(sourcePath)).toBe(true);
      } else {
        expect(result.warnings).toEqual([]);
        expect(readTaskRecord(database.db, "task-one")).toMatchObject({
          runId: "run-one",
          childSessionKey: "agent:main:subagent:one",
        });
        const before = snapshot(database.db);
        fs.copyFileSync(`${sourcePath}.migrated`, sourcePath);
        expect(
          (await migrateLegacyTaskStateSidecars({ stateDir: state.stateDir })).warnings,
        ).toEqual([]);
        expect(snapshot(database.db)).toEqual(before);
      }
    });
  },
);
