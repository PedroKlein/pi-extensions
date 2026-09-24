import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

class PasswordPrompt implements Component, Focusable {
  focused = false;
  private value = "";
  private paste = "";
  private pasting = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (password: Buffer | null) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.finish(null);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const password = Buffer.from(this.value);
      this.value = "";
      this.done(password);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.value = [...this.value].slice(0, -1).join("");
      this.tui.requestRender();
      return;
    }

    if (data.includes("\x1b[200~")) {
      this.pasting = true;
      this.paste = "";
      data = data.replace("\x1b[200~", "");
    }
    if (this.pasting) {
      this.paste += data;
      const end = this.paste.indexOf("\x1b[201~");
      if (end < 0) return;
      data = this.paste.slice(0, end);
      this.paste = "";
      this.pasting = false;
    }
    if ([...data].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    })) return;

    this.value += data;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const borderWidth = Math.max(1, width - 2);
    const border = (text: string) => this.theme.fg("borderAccent", text);
    const line = (text: string) => {
      const content = truncateToWidth(text, borderWidth, "");
      return `${border("│")}${content}${" ".repeat(Math.max(0, borderWidth - visibleWidth(content)))}${border("│")}`;
    };
    const bullets = "•".repeat(Math.min([...this.value].length, Math.max(0, borderWidth - 3)));
    const cursor = this.focused ? `${CURSOR_MARKER}${this.theme.inverse(" ")}` : "";

    return [
      border(`╭${"─".repeat(borderWidth)}╮`),
      line(` ${this.theme.bold("Sudo password")}`),
      line(""),
      line(` ${bullets}${cursor}`),
      line(` ${this.theme.fg("dim", "Enter submit · Esc cancel")}`),
      border(`╰${"─".repeat(borderWidth)}╯`),
    ];
  }

  invalidate(): void {}

  dispose(): void {
    this.value = "";
    this.paste = "";
  }

  private finish(result: null): void {
    this.value = "";
    this.paste = "";
    this.done(result);
  }
}

export function promptSudoPassword(ctx: ExtensionContext): Promise<Buffer | null> {
  return ctx.ui.custom<Buffer | null>(
    (tui, theme, _keybindings, done) => new PasswordPrompt(tui, theme, done),
  );
}
