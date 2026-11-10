// Small text helpers shared by the git output parsers. Pure and browser-safe.

/**
 * Undo git's C-style path quoting ("a\tb", "\303\274"). Unquoted input is returned unchanged.
 * Octal escapes are UTF-8 bytes, so they are collected and decoded together.
 */
export function unquoteCPath(s: string): string {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      for (const b of enc.encode(ch)) bytes.push(b);
      continue;
    }
    const n = body[++i];
    if (n === undefined) break;
    if (n >= "0" && n <= "7") {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8) & 0xff);
      i += 2;
      continue;
    }
    const map: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
    bytes.push(map[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Split NUL-delimited output into tokens, dropping a trailing empty token. */
export function splitNul(s: string): string[] {
  const parts = s.split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Remove credentials from URLs: "https://user:token@host/x" -> "https://host/x". */
export function scrubUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]*)@/i, (_m, scheme: string, userinfo: string) => {
    const lower = scheme.toLowerCase();
    if (lower.startsWith("http")) return scheme;
    // Keep a bare user name for ssh-like transports ("ssh://git@host"), drop any password.
    const user = userinfo.split(":")[0];
    return user ? `${scheme}${user}@` : scheme;
  });
}

/** Scrub every URL-embedded credential in free text (command output, invocations). */
export function scrubText(s: string): string {
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s'"]+)@/gi, (_m, scheme: string, userinfo: string) => {
    if (scheme.toLowerCase().startsWith("http")) return `${scheme}***@`;
    const user = userinfo.split(":")[0];
    return userinfo.includes(":") ? `${scheme}${user}:***@` : `${scheme}${userinfo}@`;
  });
}

/** Quote one argument for display (POSIX shell style). Display only: never executed. */
export function displayArg(a: string): string {
  return /^[A-Za-z0-9_@%+=:,./^~{}-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export function displayCommand(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].map(displayArg).join(" ");
}
