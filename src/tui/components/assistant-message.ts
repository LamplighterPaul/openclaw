// Assistant message component renders assistant responses and spacing in the TUI log.
import { visibleWidth } from "@earendil-works/pi-tui";
import { tuiTheme as theme } from "../theme/theme.js";
import { MarkdownMessageComponent } from "./markdown-message.js";
import type { TuiImageRenderer } from "./message-images.js";

export class AssistantMessageComponent extends MarkdownMessageComponent {
  constructor(text: string, imageRenderer?: TuiImageRenderer) {
    super(
      text,
      0,
      {
        // Keep assistant body text in terminal default foreground so contrast
        // follows the user's terminal theme (dark or light).
        color: (line) => theme.assistantText(line),
      },
      undefined,
      imageRenderer,
    );
  }
  override render(width: number): string[] {
    const lines = super.render(width);
    const firstContent = lines.findIndex((line) => visibleWidth(line) > 0);
    if (firstContent < 0) {
      return lines;
    }
    // Mark the message once without changing Markdown wrapping or image positioning.
    return [...lines.slice(0, firstContent), theme.dim("●"), ...lines.slice(firstContent)];
  }
}
