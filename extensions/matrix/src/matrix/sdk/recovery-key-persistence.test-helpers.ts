import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { MatrixSnapshotStateRuntime } from "../crypto-state-store.js";

export function holdRecoveryKeyPersistence() {
  const admitted = createDeferred<void>();
  const release = createDeferred<void>();
  const stateRuntime: MatrixSnapshotStateRuntime = {
    openKeyedStore<T>(options: OpenAsyncKeyedStoreOptions): PluginStateKeyedStore<T> {
      const store = createPluginStateKeyedStoreForTests<T>("matrix", options);
      const compareAndApply = store.compareAndApply;
      if (!compareAndApply) {
        throw new Error("expected current SQLite comparison support");
      }
      return {
        ...store,
        compareAndApply: async (key, comparison, intent) => {
          if (options.namespace === "recovery-key" && intent.action === "set") {
            admitted.resolve();
            await release.promise;
          }
          return await compareAndApply(key, comparison, intent);
        },
      };
    },
  };
  return { admitted, release, stateRuntime };
}
