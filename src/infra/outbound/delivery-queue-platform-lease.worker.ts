import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  claimDeliveryQueueEntryPlatformSendInDatabase,
  renewDeliveryQueueEntryPlatformSendLeaseInDatabase,
} from "../delivery-queue-sqlite-claim.kernel.js";
import type { DeliveryQueueWorkerOperations } from "../delivery-queue.worker-contract.js";
import type { SqliteWorkerCommand } from "../sqlite-worker-contract.js";

type LeaseOperations = Pick<
  DeliveryQueueWorkerOperations,
  "deliveryQueue.claimPlatformSend" | "deliveryQueue.renewPlatformSendLease"
>;

export function isDeliveryQueuePlatformLeaseCommand(command: {
  type: string;
}): command is { type: keyof LeaseOperations } {
  return (
    command.type === "deliveryQueue.claimPlatformSend" ||
    command.type === "deliveryQueue.renewPlatformSendLease"
  );
}

export function executeDeliveryQueuePlatformLeaseCommand(
  command: SqliteWorkerCommand<LeaseOperations>,
  options: { database: OpenClawStateDatabase; env: NodeJS.ProcessEnv },
): LeaseOperations[keyof LeaseOperations]["output"] {
  return runOpenClawStateWriteTransaction(
    (database) =>
      command.type === "deliveryQueue.claimPlatformSend"
        ? claimDeliveryQueueEntryPlatformSendInDatabase(
            database,
            command.input,
            command.input.claimId,
          )
        : renewDeliveryQueueEntryPlatformSendLeaseInDatabase(database, command.input),
    options,
    {
      operationLabel: `${command.type === "deliveryQueue.claimPlatformSend" ? "claim" : "renew"} ${command.input.queueName} delivery platform send`,
    },
  );
}
