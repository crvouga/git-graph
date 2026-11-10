// node run.cjs <extDir> <repoPath> <outDir> <width> <height> [scale]
const Module = require("module");
const path = require("path");
const fs = require("fs");
const [extDir, repo, outDir, W, Hh, scale] = process.argv.slice(2);
const stubPath = path.join(__dirname, "vscode-stub.cjs");
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) { return req === "vscode" ? stubPath : orig.call(this, req, ...a); };
const vscode = require(stubPath);
const { GitGraphView } = require(path.join(extDir, "out/gitGraphView.js"));
const { DataSource } = require(path.join(extDir, "out/dataSource.js"));
const { chromium } = require(process.env.PW_PATH);
const ev = () => new vscode.EventEmitter().event;
const logger = { log() {}, logCmd() {}, logError(e) { console.error("[ext log]", e); } };
(async () => {
  const ds = new DataSource({ path: "git", version: "2.54.0" }, ev(), ev(), logger);
  const repoState = { cdvDivider: 0.5, cdvHeight: 250, columnWidths: null, commitOrdering: "default", fileViewType: 0, hideRemotes: [], includeCommitsMentionedByReflogs: 0, issueLinkingConfig: null, lastImportAt: 0, name: null, onlyFollowFirstParent: 0, onRepoLoadShowCheckedOutBranch: 0, onRepoLoadShowSpecificBranches: null, pullRequestConfig: null, showRemoteBranches: true, showRemoteBranchesV2: 0, showStashes: 0, showTags: 0, workspaceFolderIndex: 0 };
  const repoManager = { getRepos: () => ({ [repo]: repoState }), onDidChangeRepos: ev(), checkReposExist: async () => false, setRepoState() {}, searchWorkspaceForRepos: async () => {}, exportRepoConfig: async () => null };
  const extensionState = { getGlobalViewState: () => ({ alwaysAcceptCheckoutCommit: false, issueLinkingConfig: null, pushTagSkipRemoteCheck: false }), getWorkspaceViewState: () => ({ findIsCaseSensitive: false, findIsRegex: false, findOpenCommitDetailsView: false }), getLastActiveRepo: () => repo, setLastActiveRepo() {}, setGlobalViewState: async () => null, setWorkspaceViewState: async () => null, isAvatarStorageAvailable: () => false, getCodeReview: () => null, startCodeReview: async () => ({ error: null }), endCodeReview: async () => null, updateCodeReview: async () => null };
  const avatarManager = { onAvatar: ev(), fetchAvatarImage() {}, getAvatarImage: async () => null };
  new GitGraphView(extDir, ds, extensionState, avatarManager, repoManager, logger, { repo }, 1);
  await new Promise((r) => setTimeout(r, 300));
  let html = vscode.__panel.html;
  const themeVars = "--vscode-font-family:-apple-system, BlinkMacSystemFont, sans-serif;--vscode-font-size:13px;--vscode-font-weight:normal;--vscode-editor-font-family:Menlo, Monaco, 'Courier New', monospace;--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#cccccc;--vscode-foreground:#cccccc;--vscode-focusBorder:#007fd4;--vscode-widget-shadow:rgba(0,0,0,0.36);--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-dropdown-background:#3c3c3c;--vscode-dropdown-foreground:#f0f0f0;--vscode-dropdown-border:#3c3c3c;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#cccccc;--vscode-button-background:#0e639c;--vscode-button-foreground:#ffffff;--vscode-menu-background:#252526;--vscode-menu-foreground:#cccccc;--vscode-menu-selectionBackground:#04395e;--vscode-scrollbarSlider-background:rgba(121,121,121,0.4);--vscode-textLink-foreground:#3794ff;--vscode-editorWidget-background:#252526;--vscode-sideBar-background:#252526;--vscode-gitDecoration-addedResourceForeground:#81b88b;--vscode-gitDecoration-modifiedResourceForeground:#e2c08d;--vscode-gitDecoration-deletedResourceForeground:#c74e39;--vscode-gitDecoration-renamedResourceForeground:#73c991;--vscode-gitDecoration-untrackedResourceForeground:#73c991;--vscode-editor-selectionBackground:#264f78;--vscode-settings-checkboxBackground:#3c3c3c;--vscode-checkbox-background:#3c3c3c;--vscode-checkbox-border:#3c3c3c;";
  html = html.replace("<html", `<html style="${themeVars}"`).replace("<body", '<body class="vscode-dark" data-vscode-theme-kind="vscode-dark"');
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: +W, height: +Hh }, deviceScaleFactor: +(scale || 1), colorScheme: "dark" })).newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.route("http://ref.local/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/" || u.pathname === "/index.html") return route.fulfill({ contentType: "text/html", body: html });
    const f = path.join(extDir, u.pathname);
    return route.fulfill({ path: f, contentType: f.endsWith(".css") ? "text/css" : "application/javascript" });
  });
  await page.exposeFunction("__toHost", (m) => vscode.__panel.onMsg(m));
  vscode.__panel.post = (m) => page.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: m })), m).catch(() => {});
  await page.addInitScript(() => { let st = null; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost(m), getState: () => st, setState: (s) => (st = s) }); });
  await page.goto("http://ref.local/index.html");
  await page.addStyleTag({ content: `:root{${themeVars}} body{background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);}` });
  await page.evaluate(() => document.body.classList.add("vscode-dark"));
  await page.waitForTimeout(2500);
  fs.mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, "ref-graph.png") });
  // expanded commit (click the 3rd commit row = main "Add sub()")
  const rows = page.locator("#commitTable tr.commit");
  await rows.nth(2).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(outDir, "ref-details.png") });
  // comparison: ctrl/meta-click another commit
  await rows.nth(10).click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(outDir, "ref-compare.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  // branch filter dropdown
  await page.locator("#branchDropdown").click().catch((e) => console.error("dropdown", e.message));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "ref-branches.png") });
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);
  // context menu on a commit
  await rows.nth(5).click({ button: "right" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "ref-menu.png") });
  const metrics = await page.evaluate(() => {
    const r = document.querySelector("#commitTable tr.commit");
    const th = [...document.querySelectorAll("#commitTable th")].map((t) => [t.textContent.trim(), Math.round(t.getBoundingClientRect().width)]);
    return { rowHeight: r ? r.getBoundingClientRect().height : null, headers: th, controlsHeight: document.getElementById("controls")?.getBoundingClientRect().height, font: getComputedStyle(document.body).fontFamily, fontSize: getComputedStyle(document.body).fontSize };
  });
  console.log(JSON.stringify(metrics));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
