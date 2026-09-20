import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { objectFieldEquals, startTuiFixture } from "./tui-pty-harness-fixture-test-support.js";

const STARTUP_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 5_000;
const STARTUP_TEST_TIMEOUT_MS = 25_000;

it.runIf(process.platform === "linux")(
  "pastes a clipboard image through the running TUI and clears it at draft boundaries",
  async () => {
    const helperDir = await mkdtemp(path.join(tmpdir(), "tui-clipboard-helper-"));
    const payload =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12NQSFgAAAHEASGzfJWiAAAAAElFTkSuQmCC";
    await writeFile(
      path.join(helperDir, "wl-paste"),
      `#!/bin/sh
if [ "$1" = "--list-types" ]; then printf 'image/png\\n'; else printf '${payload}' | base64 -d; fi
`,
      { mode: 0o700 },
    );
    let fixture: Awaited<ReturnType<typeof startTuiFixture>> | undefined;
    try {
      fixture = await startTuiFixture({
        env: {
          WAYLAND_DISPLAY: "fixture",
          PATH: `${helperDir}${path.delimiter}${process.env.PATH}`,
        },
      });
      await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
      await fixture.run.write("\u0016");
      await fixture.run.waitForOutput("1 image attached", TEST_TIMEOUT_MS);
      await fixture.run.write("Describe the image\r");
      const sent = await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" && objectFieldEquals(entry, "message", "Describe the image"),
      );
      expect(sent).toMatchObject({
        payload: { attachments: [{ type: "image", mimeType: "image/png", content: payload }] },
      });
      await fixture.run.write("\u0016");
      await fixture.run.waitForOutput("1 image attached", TEST_TIMEOUT_MS);
      await fixture.run.write("\u0003");
      await fixture.run.waitForOutput("cleared input", TEST_TIMEOUT_MS);
      await fixture.run.write("Unrelated message\r");
      const next = await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" && objectFieldEquals(entry, "message", "Unrelated message"),
      );
      expect(next).not.toHaveProperty("payload.attachments");
    } finally {
      await fixture?.cleanup();
      await rm(helperDir, { recursive: true, force: true });
    }
  },
  STARTUP_TEST_TIMEOUT_MS,
);
