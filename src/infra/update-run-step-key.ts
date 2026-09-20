// Restored 2026.9.4/2026.9.5 readers recognize fetch outcomes by these ledger keys.
const FETCH_STEP_KEYS = new Map<string, string>([
  ["git-fetch", "git fetch"],
  ["git-fetch-tags", "git fetch tags"],
  ["git-fetch-target-tag", "git fetch target tag"],
  ["git-target-inspection-fetch", "git target inspection fetch"],
  ["git-import-admitted-target", "git import admitted target"],
]);

export function updateRunStepKey(step: string): string {
  return FETCH_STEP_KEYS.get(step) ?? step;
}
