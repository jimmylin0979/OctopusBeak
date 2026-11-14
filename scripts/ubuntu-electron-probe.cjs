// Run by scripts/doctor.mjs as an Electron main process, with the sandbox on.
// If Chromium cannot sandbox its renderers it aborts before printing anything.
const { app, BrowserWindow, safeStorage } = require("electron");

app.enableSandbox();

function report(result, code) {
  process.stdout.write(`OCTOPUSBEAK_PROBE ${JSON.stringify(result)}\n`, () => app.exit(code));
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await window.loadURL("data:text/html,probe");
  const sandboxed = await window.webContents.executeJavaScript("typeof require === 'undefined'");
  report({
    status: sandboxed ? "passed" : "failed",
    reason: sandboxed ? "sandboxed-renderer" : "renderer-not-sandboxed",
    backend: safeStorage.getSelectedStorageBackend?.() ?? null,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  }, sandboxed ? 0 : 1);
}).catch(() => report({ status: "failed", reason: "electron-startup-error" }, 1));
