import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import type { TuiImageAttachment } from "./tui-backend.js";

/** Owns unsent images and invalidates reads across every draft boundary. */
export function createAttachmentDraft(options: {
  read: (signal: AbortSignal) => Promise<TuiImageAttachment | null>;
  notice: (message: string) => void;
  changed: (count: number, reading: boolean) => void;
}) {
  let images: TuiImageAttachment[] = [];
  let generation = 0;
  let pending: AbortController | undefined;
  const changed = () => options.changed(images.length, Boolean(pending));
  const clear = () => {
    generation += 1;
    pending?.abort();
    pending = undefined;
    images = [];
    changed();
  };
  const restore = (attachments: TuiImageAttachment[]) => {
    images = [...attachments, ...images];
    changed();
  };
  return {
    clear,
    restore,
    hasInput: () => images.length > 0 || Boolean(pending),
    captureRestore: () => {
      const capturedGeneration = generation;
      return (attachments: TuiImageAttachment[]) => {
        if (generation !== capturedGeneration) {
          return false;
        }
        restore(attachments);
        return true;
      };
    },
    capture: () => {
      const captured = { attachments: images, clipboardPending: Boolean(pending) };
      images = [];
      changed();
      return captured;
    },
    async paste() {
      if (pending) {
        return;
      }
      const request = new AbortController();
      pending = request;
      changed();
      try {
        const image = await options.read(request.signal);
        if (pending !== request) {
          return;
        }
        if (!image) {
          options.notice(
            "No image in clipboard. Use your terminal's normal paste shortcut for text.",
          );
        } else if (
          images.length >= 4 ||
          images.reduce((size, item) => size + item.sizeBytes, image.sizeBytes) > MAX_IMAGE_BYTES
        ) {
          options.notice(
            "Draft limit: four images and 6 MiB total. Send or clear this draft first.",
          );
        } else {
          images.push(image);
        }
      } catch (error) {
        if (pending === request) {
          options.notice(error instanceof Error ? error.message : "Clipboard image read failed.");
        }
      } finally {
        if (pending === request) {
          pending = undefined;
          changed();
        }
      }
    },
  };
}
