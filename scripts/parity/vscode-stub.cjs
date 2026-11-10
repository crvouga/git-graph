// Minimal stand-in for the `vscode` module so Git Graph's host code can run headless.
class EventEmitter { constructor() { this.l = new Set(); this.event = (cb) => { this.l.add(cb); return { dispose: () => this.l.delete(cb) }; }; } fire(e) { for (const f of this.l) f(e); } dispose() {} }
const mkUri = (p) => ({ fsPath: p, path: p, scheme: "file", toString: () => `file://${p}`, with: () => mkUri(p) });
const cfg = { get: (k, d) => d, inspect: () => undefined, has: () => false, update: async () => {} };
const panelState = { html: "", onMsg: null, post: null };
module.exports = {
  EventEmitter,
  Disposable: class { static from() { return { dispose() {} }; } constructor(f) { this.f = f; } dispose() { this.f?.(); } },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
  Uri: { file: mkUri, parse: (s) => mkUri(s), joinPath: (u, ...p) => mkUri([u.fsPath, ...p].join("/")) },
  env: { clipboard: { writeText: async () => {} }, openExternal: async () => true },
  commands: { executeCommand: async () => {} },
  workspace: { getConfiguration: () => cfg, workspaceFolders: [], createFileSystemWatcher: () => ({ onDidCreate: () => ({ dispose() {} }), onDidChange: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: {
    activeTextEditor: undefined,
    showErrorMessage: async (m) => console.error("[ext error]", m),
    showInformationMessage: async () => {},
    showInputBox: async () => undefined,
    showSaveDialog: async () => undefined,
    createTerminal: () => ({ show() {}, sendText() {} }),
    createWebviewPanel: () => {
      const webview = {
        cspSource: "http://ref.local",
        asWebviewUri: (u) => ({ toString: () => `http://ref.local/${u.fsPath.split("/").slice(-2).join("/")}` }),
        set html(h) { panelState.html = h; },
        get html() { return panelState.html; },
        onDidReceiveMessage: (cb) => { panelState.onMsg = cb; return { dispose() {} }; },
        postMessage: async (m) => { panelState.post?.(m); return true; },
      };
      return { webview, visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }), reveal() {}, dispose() {} };
    },
  },
  __panel: panelState,
};
