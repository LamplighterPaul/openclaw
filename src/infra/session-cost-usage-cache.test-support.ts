import { normalizeAgentId } from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  readSessionCostUsageRollupRowsInDatabase,
  readSessionCostUsageRollupBodyInDatabase,
  type SessionCostUsageRollupRow,
} from "./session-cost-usage-cache.kernel.js";
import {
  decodeUsageCostRollup,
  decodeUsageCostRollupEnvelope,
} from "./session-cost-usage-rollup-codec.js";

export function readSessionCostUsageRollupRows(
  agentId?: string,
  databasePath?: string,
): SessionCostUsageRollupRow[] {
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => readSessionCostUsageRollupRowsInDatabase(db),
    { agentId: normalizeAgentId(agentId), ...(databasePath ? { path: databasePath } : {}) },
  );
  return result.found ? result.value : [];
}

export function readSessionCostUsageRollupEntry(
  row: SessionCostUsageRollupRow,
  agentId?: string,
  databasePath?: string,
) {
  const envelope = decodeUsageCostRollupEnvelope(row.valueJson);
  if (!envelope) return undefined;
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => {
      const body = readSessionCostUsageRollupBodyInDatabase(db, row);
      return body
        ? decodeUsageCostRollup(row.valueJson, envelope.pricingFingerprint, body.blob)
        : undefined;
    },
    { agentId: normalizeAgentId(agentId), ...(databasePath ? { path: databasePath } : {}) },
  );
  return result.found ? result.value : undefined;
}
