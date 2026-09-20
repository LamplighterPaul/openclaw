import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { CustomEditor } from "./components/custom-editor.js";
import { editorTheme } from "./theme/theme.js";
import { createAttachmentDraft } from "./tui-attachment-draft.js";
import type { TuiImageAttachment } from "./tui-backend.js";
import { createEditorSubmitHandler, createSubmitBurstCoalescer } from "./tui-submit.js";

const image: TuiImageAttachment = {
  type: "image",
  origin: "paste",
  mimeType: "image/png",
  content: "aW1hZ2U=",
  sizeBytes: 5,
};
function harness(read = async () => image) {
  const editor = new CustomEditor({ requestRender: vi.fn() } as unknown as TUI, editorTheme);
  const notice = vi.fn();
  const draft = createAttachmentDraft({ read, notice, changed: vi.fn() });
  const sendMessage = vi.fn();
  const handler = createEditorSubmitHandler({
    editor,
    sendMessage,
    handleCommand: vi.fn(),
    handleBangLine: vi.fn(),
    onSubmitError: vi.fn(),
    restoreAttachments: draft.restore,
    clearAttachments: draft.clear,
  });
  const submit = createSubmitBurstCoalescer({
    submit: handler,
    enabled: false,
    captureSnapshot: () => ({
      sessionTransition: null,
      sessionTransitionEpoch: 0,
      ...draft.capture(),
    }),
  });
  editor.onSubmit = submit;
  editor.onCtrlV = () => {
    void draft.paste();
  };
  return { editor, draft, sendMessage, notice };
}

describe("clipboard draft lifecycle", () => {
  it("sends an image-only draft through the real editor submit path", async () => {
    const { editor, sendMessage } = harness();
    editor.handleInput("\u0016");
    await Promise.resolve();
    editor.handleInput("\r");
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("", [image]);
  });

  it.each(["/help", "!pwd"])("discards attachments when submitting %s", async (command) => {
    const { editor, draft, sendMessage } = harness();
    await draft.paste();
    editor.setText(command);
    editor.handleInput("\r");
    editor.setText("next message");
    editor.handleInput("\r");
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("next message");
  });

  it("discards a late clipboard result after the draft is cleared", async () => {
    let complete!: (value: TuiImageAttachment) => void;
    const { draft } = harness(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const paste = draft.paste();
    draft.clear();
    complete(image);
    await paste;
    expect(draft.capture().attachments).toEqual([]);
  });

  it("does not restore a failed send into a different draft generation", async () => {
    const { draft } = harness();
    const restore = draft.captureRestore();
    draft.clear();
    expect(restore([image])).toBe(false);
    expect(draft.hasInput()).toBe(false);
  });

  it("enforces aggregate draft limits", async () => {
    const { draft, notice } = harness(async () => ({ ...image, sizeBytes: 4 * 1024 * 1024 }));
    await draft.paste();
    await draft.paste();
    expect(draft.capture().attachments).toHaveLength(1);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("6 MiB total"));
  });
});

it("checks aggregate images again after a buffered Enter burst", () => {
  vi.useFakeTimers();
  try {
    const sendMessage = vi.fn();
    const restoreAttachments = vi.fn();
    const onSubmitError = vi.fn();
    const handler = createEditorSubmitHandler({
      editor: { getExpandedText: () => "", setText: vi.fn(), addToHistory: vi.fn() },
      handleCommand: vi.fn(),
      handleBangLine: vi.fn(),
      sendMessage,
      restoreAttachments,
      onSubmitError,
    });
    const submit = createSubmitBurstCoalescer({
      enabled: true,
      submit: handler,
      captureSnapshot: () => ({
        sessionTransition: null,
        sessionTransitionEpoch: 0,
        attachments: [{ ...image, sizeBytes: 4 * 1024 * 1024 }],
      }),
    });
    submit("first line");
    submit("second line");
    vi.runAllTimers();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(restoreAttachments).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ sizeBytes: 4 * 1024 * 1024 })]),
    );
    expect(restoreAttachments.mock.calls[0][0]).toHaveLength(2);
    expect(onSubmitError).toHaveBeenCalledWith(
      "message",
      expect.objectContaining({ message: expect.stringContaining("6 MiB total") }),
    );
    submit.dispose();
  } finally {
    vi.useRealTimers();
  }
});
