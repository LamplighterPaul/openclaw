import { describe, expect, it, vi } from "vitest";
import { readClipboardImage } from "./clipboard-image.js";

const png = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);

describe("clipboard image reader", () => {
  it.each([
    { env: { WAYLAND_DISPLAY: "wayland-1" }, helper: "wl-paste" },
    { env: { DISPLAY: ":1" }, helper: "xclip" },
  ])("reads and validates image bytes via $helper", async ({ env, helper }) => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(Buffer.from("text/plain\nimage/png\n"))
      .mockResolvedValueOnce(png);
    const result = await readClipboardImage(new AbortController().signal, {
      platform: "linux",
      env,
      run,
    });
    expect(result).toEqual({
      type: "image",
      origin: "paste",
      mimeType: "image/png",
      content: png.toString("base64"),
      sizeBytes: png.length,
    });
    expect(run.mock.calls.map(([file]) => file)).toEqual([helper, helper]);
  });

  it("does not retrieve plain-text clipboard contents", async () => {
    const run = vi.fn().mockResolvedValue(Buffer.from("text/plain"));
    await expect(
      readClipboardImage(new AbortController().signal, {
        platform: "linux",
        env: { DISPLAY: ":1" },
        run,
      }),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects non-image content despite an advertised image MIME", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(Buffer.from("image/png"))
      .mockResolvedValueOnce(Buffer.from("private text"));
    await expect(
      readClipboardImage(new AbortController().signal, {
        platform: "linux",
        env: { DISPLAY: ":1" },
        run,
      }),
    ).rejects.toThrow("supported PNG");
  });

  it("reports an SSH-only desktop before launching a helper", async () => {
    const run = vi.fn();
    await expect(
      readClipboardImage(new AbortController().signal, { platform: "linux", env: {}, run }),
    ).rejects.toThrow("SSH-only");
    expect(run).not.toHaveBeenCalled();
  });
});
