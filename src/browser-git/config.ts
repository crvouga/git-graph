// Minimal git-config parser (read-only). Keys are "section.key" or "section.subsection.key";
// section and key names are lower-cased, subsections keep their case. Includes are not followed.

export class GitConfig {
  private readonly values = new Map<string, string[]>();

  static parse(text: string): GitConfig {
    const cfg = new GitConfig();
    let section = "";
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]!;
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] === "#" || trimmed[0] === ";") continue;
      if (trimmed[0] === "[") {
        const m = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/.exec(trimmed);
        if (!m) continue;
        const name = m[1]!.toLowerCase();
        if (m[2] !== undefined) section = `${name}.${m[2].replace(/\\(.)/g, "$1")}`;
        else {
          // Deprecated [section.Sub] syntax.
          const dot = name.indexOf(".");
          section = dot < 0 ? name : `${name.slice(0, dot)}.${m[1]!.slice(dot + 1)}`;
        }
        line = m[3]!;
        if (!line.trim()) continue;
      }
      const km = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(=?)(.*)$/.exec(line);
      if (!km || !section) continue;
      const key = `${section}.${km[1]!.toLowerCase()}`;
      if (!km[2]) {
        cfg.add(key, "true");
        continue;
      }
      let raw = km[3]!;
      // Line continuations.
      while (/(^|[^\\])(\\\\)*\\$/.test(raw) && i + 1 < lines.length) raw = raw.slice(0, -1) + lines[++i]!;
      cfg.add(key, parseValue(raw));
    }
    return cfg;
  }

  private add(key: string, v: string) {
    const arr = this.values.get(key);
    if (arr) arr.push(v);
    else this.values.set(key, [v]);
  }

  get(key: string): string | undefined {
    const arr = this.values.get(normalizeKey(key));
    return arr ? arr[arr.length - 1] : undefined;
  }

  getAll(key: string): string[] {
    return this.values.get(normalizeKey(key)) ?? [];
  }

  getBool(key: string): boolean | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    return ["true", "yes", "on", "1"].includes(v.toLowerCase());
  }

  /** Subsection names of a section, e.g. subsections("remote") → ["origin"]. */
  subsections(section: string): string[] {
    const prefix = section.toLowerCase() + ".";
    const out = new Set<string>();
    for (const k of this.values.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const dot = rest.lastIndexOf(".");
      if (dot > 0) out.add(rest.slice(0, dot));
    }
    return [...out];
  }
}

function normalizeKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === last) return key.toLowerCase();
  return key.slice(0, first).toLowerCase() + key.slice(first, last) + key.slice(last).toLowerCase();
}

function parseValue(raw: string): string {
  let out = "";
  let quoted = false;
  let pendingSpace = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (c === "#" || c === ";")) break;
    if (c === "\\" && i + 1 < raw.length) {
      const n = raw[++i]!;
      out += pendingSpace + (n === "n" ? "\n" : n === "t" ? "\t" : n === "b" ? "\b" : n);
      pendingSpace = "";
      continue;
    }
    if (!quoted && (c === " " || c === "\t")) {
      if (out) pendingSpace += c;
      continue;
    }
    out += pendingSpace + c;
    pendingSpace = "";
  }
  return out;
}
