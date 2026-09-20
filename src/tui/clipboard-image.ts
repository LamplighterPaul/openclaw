// Clipboard access runs on the TUI host, never on the connected Gateway.
import { execFile } from "node:child_process";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { sniffInlineImageMime } from "@openclaw/media-core/inline-image-data-url";
import type { TuiImageAttachment } from "./tui-backend.js";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const READ_TIMEOUT_MS = 3_000;

// Built-in OS bridges avoid optional, undeclared native Node dependencies.
const MAC_READ_IMAGE = `ObjC.import('AppKit');
const image = $.NSImage.alloc.initWithPasteboard($.NSPasteboard.generalPasteboard);
if (!image.isNil()) {
  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  png.base64EncodedStringWithOptions(0).js;
} else { ''; }`;
const WINDOWS_READ_IMAGE = `Add-Type -AssemblyName System.Windows.Forms;
if ([Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [Windows.Forms.Clipboard]::GetImage();
  $stream = New-Object IO.MemoryStream;
  try { $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($stream.ToArray()) }
  finally { $stream.Dispose(); $image.Dispose() }
}`;

export type ClipboardCommand = (
  file: string,
  args: string[],
  signal: AbortSignal,
) => Promise<Buffer>;

export const runClipboardCommand: ClipboardCommand = (file, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "buffer",
        signal,
        timeout: READ_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          // Do not echo clipboard contents or helper stderr into the transcript.
          reject(
            new Error(
              `Clipboard helper ${file} failed; check it is installed and your desktop clipboard is accessible.`,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });

export async function readClipboardImage(
  signal: AbortSignal,
  options: { platform?: string; env?: NodeJS.ProcessEnv; run?: ClipboardCommand } = {},
): Promise<TuiImageAttachment | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runClipboardCommand;
  // One deadline covers discovery and payload, not three seconds per subprocess.
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
  let bytes: Buffer;
  if (platform === "darwin") {
    bytes = Buffer.from(
      (await run("osascript", ["-l", "JavaScript", "-e", MAC_READ_IMAGE], deadline))
        .toString()
        .trim(),
      "base64",
    );
  } else if (platform === "win32") {
    bytes = Buffer.from(
      (
        await run(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_READ_IMAGE],
          deadline,
        )
      )
        .toString()
        .trim(),
      "base64",
    );
  } else if (platform === "linux") {
    const wayland = Boolean(env.WAYLAND_DISPLAY);
    if (!wayland && !env.DISPLAY) {
      throw new Error(
        "No desktop clipboard available. Run the TUI on your desktop (not an SSH-only host).",
      );
    }
    const helper = wayland ? "wl-paste" : "xclip";
    const types = (
      await run(
        helper,
        wayland ? ["--list-types"] : ["-selection", "clipboard", "-t", "TARGETS", "-o"],
        deadline,
      )
    )
      .toString()
      .split(/\s+/u);
    const mimeType = IMAGE_TYPES.find((type) => types.includes(type));
    if (!mimeType) {
      return null;
    }
    bytes = await run(
      helper,
      wayland
        ? ["--no-newline", "--type", mimeType]
        : ["-selection", "clipboard", "-t", mimeType, "-o"],
      deadline,
    );
  } else {
    throw new Error("Clipboard image paste is supported on Linux, macOS, and Windows.");
  }
  deadline.throwIfAborted();
  if (bytes.length === 0) {
    return null;
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Clipboard image exceeds 6 MiB. Copy a smaller screenshot.");
  }
  const mimeType = sniffInlineImageMime(bytes);
  if (!mimeType || !IMAGE_TYPES.includes(mimeType)) {
    throw new Error("Clipboard does not contain a supported PNG, JPEG, WebP, or GIF image.");
  }
  return {
    type: "image",
    origin: "paste",
    mimeType,
    content: bytes.toString("base64"),
    sizeBytes: bytes.length,
  };
}
