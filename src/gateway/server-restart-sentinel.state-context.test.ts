import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureDeliveryQueueStateContext } from "../infra/delivery-queue-state-context.js";
import { findDeliveryIntentOwner } from "../infra/outbound/delivery-queue-storage.js";
import { readRestartSentinel, writeRestartSentinel } from "../infra/restart-sentinel.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn<typeof import("./session-utils.js").loadSessionEntry>(),
  sendDurableMessageBatchCore: vi.fn(async () => ({
    status: "sent" as const,
    results: [{ channel: "matrix" as const, messageId: "synthetic-notice" }],
  })),
  hookRunner: {
    hasHooks: (name: string) => name === "message_sending",
    runMessageSending: vi.fn(async () => undefined),
  },
}));

vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: mocks.loadSessionEntry,
}));
vi.mock("../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/heartbeat-wake.js")>()),
  requestHeartbeat: vi.fn(),
}));
vi.mock("../channels/message/runtime.js", () => ({
  sendDurableMessageBatchCore: mocks.sendDurableMessageBatchCore,
}));
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocks.hookRunner,
}));

const { scheduleRestartSentinelWake } = await import("./server-restart-sentinel.js");
let envSnapshot: ReturnType<typeof captureEnv>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginRuntimeStateForTest();
    resetGatewayWorkAdmission();
    resetSystemEventsForTest();
    vi.restoreAllMocks();
    envSnapshot.restore();
    cleanup();
  });
});

beforeEach(() => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_SUPERVISOR_MODE"]);
  setTestEnvValue("OPENCLAW_SUPERVISOR_MODE", "");
  vi.clearAllMocks();
  mocks.loadSessionEntry.mockReturnValue({
    cfg: { commands: { ownerAllowFrom: ["matrix:!operator:example"] } },
    agentId: "main",
    entry: { sessionId: "synthetic-session", updatedAt: 1 },
    store: {},
    storePath: "/synthetic/openclaw-agent.sqlite",
    canonicalKey: "agent:main:main",
    storeKeys: ["agent:main:main"],
    legacyKey: undefined,
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "matrix",
          outbound: createDirectOutboundTestAdapter({ channel: "matrix" }),
        }),
      },
    ]),
  );
});

it.each([false, true])(
  "consumes only the captured restart sentinel after preparation changes state root (newer=%s)",
  async (replaceOriginal) => {
    const originalRoot = tempDirs.make("openclaw-restart-startup-original-");
    const unrelatedRoot = tempDirs.make("openclaw-restart-startup-unrelated-");
    const originalEnv = { OPENCLAW_STATE_DIR: originalRoot };
    const unrelatedEnv = { OPENCLAW_STATE_DIR: unrelatedRoot };
    setTestEnvValue("OPENCLAW_STATE_DIR", originalRoot);
    const context = captureDeliveryQueueStateContext();
    const payload = {
      kind: "restart" as const,
      status: "ok" as const,
      ts: 123,
      sessionKey: "agent:main:main",
      deliveryContext: { channel: "matrix", to: "!operator:example" },
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const original = await writeRestartSentinel(payload, originalEnv);
    const unrelated = await writeRestartSentinel(
      { ...payload, message: "unrelated restart" },
      unrelatedEnv,
    );
    clock.mockRestore();
    expect(unrelated.revision).toBe(original.revision);
    let retained: Awaited<ReturnType<typeof readRestartSentinel>> = null;
    mocks.hookRunner.runMessageSending.mockImplementationOnce(async () => {
      if (replaceOriginal) {
        retained = await writeRestartSentinel(
          { ...payload, message: "newer restart" },
          originalEnv,
        );
      }
      setTestEnvValue("OPENCLAW_STATE_DIR", unrelatedRoot);
      return undefined;
    });

    await scheduleRestartSentinelWake({ deps: {} });

    expect(mocks.hookRunner.runMessageSending).toHaveBeenCalledOnce();
    expect(await readRestartSentinel(unrelatedEnv)).toEqual(unrelated);
    expect(await readRestartSentinel(originalEnv)).toEqual(retained);
    expect(mocks.sendDurableMessageBatchCore).toHaveBeenCalledOnce();
    const noticeId = `restart-sentinel-notice:agent:main:main:${original.revision}`;
    expect(findDeliveryIntentOwner(noticeId, undefined, context)).toMatchObject({
      status: "completed",
    });
    expect(findDeliveryIntentOwner(noticeId, unrelatedRoot)).toBeNull();
  },
);
