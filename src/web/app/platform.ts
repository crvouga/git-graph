// Platform helpers: modifier naming, shortcut parsing/matching and reserved-shortcut filtering.

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface ParsedShortcut {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** "Mod+Shift+P" → parsed. "Mod" = Cmd on macOS, Ctrl elsewhere. */
export function parseShortcut(s: string): ParsedShortcut {
  const parts = s.split("+");
  const key = parts.pop()!;
  const set = new Set(parts.map((p) => p.toLowerCase()));
  return { key: key.length === 1 ? key.toLowerCase() : key, mod: set.has("mod"), shift: set.has("shift"), alt: set.has("alt"), ctrl: set.has("ctrl") };
}

function eventKey(e: KeyboardEvent): string {
  if (e.key === " ") return "Space";
  if (e.key.length === 1) return e.key.toLowerCase();
  return e.key;
}

export function matches(e: KeyboardEvent, s: string): boolean {
  const p = parseShortcut(s);
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const ctrlExtra = isMac ? e.ctrlKey : false;
  const k = eventKey(e);
  // "?" and other shifted symbols: compare the produced character and ignore shift.
  if (p.key === "?" || p.key === "/" ) {
    return k === p.key && mod === p.mod && e.altKey === p.alt;
  }
  return k === p.key && mod === p.mod && e.shiftKey === p.shift && e.altKey === p.alt && ctrlExtra === (isMac ? p.ctrl : false);
}

/** Browser/OS shortcuts we never bind (they would be swallowed or surprising). */
const RESERVED = ["Mod+t", "Mod+w", "Mod+n", "Mod+q", "Mod+l", "Mod+r", "Mod+Shift+t", "Mod+Shift+n", "Mod+Shift+w", "Mod+Tab", "Mod+Shift+r", "F5", "F11", "F12", ...(isMac ? ["Mod+h", "Mod+m", "Mod+,"] : ["Alt+F4"])];

export function isReserved(s: string): boolean {
  const n = s.replace(/\+([a-z])$/i, (_, c: string) => `+${c.toLowerCase()}`);
  return RESERVED.some((r) => r.toLowerCase() === n.toLowerCase());
}

const SYMBOLS: Record<string, string> = isMac
  ? { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "↩", Escape: "Esc", Space: "Space" }
  : { Mod: "Ctrl", Shift: "Shift", Alt: "Alt", Ctrl: "Ctrl", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "Enter", Escape: "Esc", Space: "Space" };

export function formatShortcut(s: string): string {
  const parts = s.split("+");
  const out = parts.map((p) => SYMBOLS[p] ?? (p.length === 1 ? p.toUpperCase() : p));
  return isMac ? out.join("") : out.join("+");
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}
