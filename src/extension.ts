/*
 * Pixel Scroll Terminal — extension entry point.
 *
 * Commands: Enable, Disable, Reapply Patch, Show Status.
 * State: persisted in globalState; on activation we reconcile (re-apply if a
 * VS Code update replaced xterm or the snippet version changed).
 *
 * The patch only takes effect once the already-loaded xterm is dropped, so each
 * mutating action offers a dismissible reload — or, on bundles that pack xterm
 * into node_modules.asar, a full app restart (see `offerActivation`).
 */

import * as vscode from 'vscode';
import {
  PatchManager,
  PatchError,
  SNIPPET_VERSION,
  isTransientError,
  type FileResult,
  type FileStatus,
  type ApplyAction,
  type RemoveAction
} from './patcher';

const STATE_KEY = 'pixelScrollTerminal.state';
// macOS App Management pane (Ventura+); falls back to Privacy & Security root if unavailable.
const APP_MGMT_URI = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles';

interface State {
  enabled: boolean;
  snippetVersion: string;
}

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Pixel Scroll Terminal');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('pixelScrollTerminal.enable', () => enableCmd(context)),
    vscode.commands.registerCommand('pixelScrollTerminal.disable', () => disableCmd(context)),
    vscode.commands.registerCommand('pixelScrollTerminal.reapply', () => reapplyCmd(context)),
    vscode.commands.registerCommand('pixelScrollTerminal.showStatus', () => showStatusCmd(context))
  );

  // A VS Code update may have replaced xterm with a fresh (unpatched) copy.
  reconcile(context);
}

export function deactivate(): void {
  // Intentionally a no-op: the on-disk patch must persist across reloads.
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  output.appendLine(`[${ts}] ${msg}`);
}

function manager(context: vscode.ExtensionContext): PatchManager {
  return new PatchManager(vscode.env.appRoot, context.extensionPath, log);
}

function getState(context: vscode.ExtensionContext): State {
  const raw = context.globalState.get<Partial<State>>(STATE_KEY);
  return {
    enabled: raw?.enabled === true,
    snippetVersion: typeof raw?.snippetVersion === 'string' ? raw.snippetVersion : ''
  };
}

async function setState(context: vscode.ExtensionContext, state: State): Promise<void> {
  await context.globalState.update(STATE_KEY, state);
}

/**
 * Prompt for whatever it takes to pick the change up.
 *
 * With plain files a window reload is enough: the renderer re-imports xterm.
 * With `node_modules.asar` it is not — the app process caches the archive's
 * header, so it keeps serving the pre-patch bytes until it is restarted.
 */
function offerActivation(mgr: PatchManager, message: string): void {
  if (mgr.needsAppRestart()) {
    const appName = vscode.env.appName;
    void vscode.window
      .showInformationMessage(
        `${message} Quit and reopen ${appName} to pick it up — a window reload is not enough, ` +
          'because the app process caches node_modules.asar.',
        `Quit ${appName}`
      )
      .then(choice => {
        if (choice === `Quit ${appName}`) {
          void Promise.resolve(vscode.commands.executeCommand('workbench.action.quit')).then(
            undefined,
            err => log(`could not quit automatically: ${err instanceof Error ? err.message : String(err)}`)
          );
        }
      });
    return;
  }
  void vscode.window.showInformationMessage(`${message} Reload the window to pick it up.`, 'Reload Window').then(choice => {
    if (choice === 'Reload Window') {
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
}

function isPermissionError(err: unknown): err is PatchError {
  return (
    err instanceof PatchError &&
    (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EROFS')
  );
}

function handleError(err: unknown, retry: () => void): void {
  if (isTransientError(err)) {
    const message = err instanceof Error ? err.message : String(err);
    log(`transient: ${message}`);
    void vscode.window.showWarningMessage(`Pixel Scroll Terminal: ${message}`, 'Try Again').then(choice => {
      if (choice === 'Try Again') {
        retry();
      }
    });
    return;
  }
  if (isPermissionError(err)) {
    const appName = vscode.env.appName;
    log(`Permission denied (${err.code}) modifying ${appName}: ${err.message}`);
    void vscode.window
      .showErrorMessage(
        `Pixel Scroll Terminal couldn't modify ${appName}. Grant permission in ` +
          `System Settings → Privacy & Security → App Management → enable ${appName}, then Retry.`,
        'Open Settings',
        'Retry'
      )
      .then(choice => {
        if (choice === 'Open Settings') {
          void vscode.env.openExternal(vscode.Uri.parse(APP_MGMT_URI));
        } else if (choice === 'Retry') {
          retry();
        }
      });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  log(`ERROR: ${message}`);
  void vscode.window.showErrorMessage(`Pixel Scroll Terminal: ${message}`);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function enableCmd(context: vscode.ExtensionContext): void {
  void setState(context, { enabled: true, snippetVersion: SNIPPET_VERSION }).then(() =>
    applyAndReport(context, false)
  );
}

function reapplyCmd(context: vscode.ExtensionContext): void {
  // Force a fresh rewrite even if markers look current (e.g. after manual edits).
  void setState(context, { enabled: true, snippetVersion: SNIPPET_VERSION }).then(() =>
    applyAndReport(context, true)
  );
}

function applyAndReport(context: vscode.ExtensionContext, force: boolean): void {
  const mgr = manager(context);
  let results: FileResult<ApplyAction>[];
  try {
    results = mgr.apply(force);
  } catch (err) {
    handleError(err, () => applyAndReport(context, force));
    return;
  }

  const patchable = results.filter(r => r.action !== 'file-missing' && r.action !== 'anchor-missing');
  if (patchable.length === 0) {
    const msg =
      'Pixel Scroll Terminal: no patchable xterm found in this editor ' +
      `(looked in ${mgr.location()}; file missing or its scroll handler changed). No changes made.`;
    log(msg);
    void vscode.window.showWarningMessage(msg);
    return;
  }

  if (results.some(r => r.changed)) {
    offerActivation(mgr, 'Pixel Scroll Terminal enabled.');
  } else {
    void vscode.window.showInformationMessage('Pixel Scroll Terminal is already enabled and up to date.');
  }
}

function disableCmd(context: vscode.ExtensionContext): void {
  const previous = getState(context).snippetVersion;
  void setState(context, { enabled: false, snippetVersion: previous }).then(() => {
    const mgr = manager(context);
    let results: FileResult<RemoveAction>[];
    try {
      results = mgr.remove();
    } catch (err) {
      handleError(err, () => disableCmd(context));
      return;
    }
    if (results.some(r => r.changed)) {
      offerActivation(mgr, 'Pixel Scroll Terminal disabled.');
    } else {
      void vscode.window.showInformationMessage('Pixel Scroll Terminal was not applied; nothing to remove.');
    }
  });
}

function reconcile(context: vscode.ExtensionContext): void {
  const state = getState(context);
  if (!state.enabled) {
    return;
  }
  const mgr = manager(context);

  let statuses: FileStatus[];
  try {
    statuses = mgr.status();
  } catch (err) {
    log(`reconcile: status failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const patchable = statuses.filter(s => s.exists && s.anchorCount === 1);
  if (patchable.length === 0) {
    log('reconcile: no patchable xterm files (editor/build unsupported or changed).');
    return;
  }
  const stale = patchable.filter(s => !s.current);
  if (stale.length === 0) {
    log('reconcile: patch present and current.');
    return;
  }

  log(`reconcile: re-applying (stale/missing in ${stale.map(s => s.kind).join(', ')}).`);
  let results: FileResult<ApplyAction>[];
  try {
    results = mgr.apply();
  } catch (err) {
    if (isTransientError(err)) {
      // Another window is doing exactly this; it does not need saying twice.
      log(`reconcile: deferring — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    handleError(err, () => reconcile(context));
    return;
  }
  if (results.some(r => r.changed)) {
    offerActivation(mgr, 'Pixel Scroll Terminal re-applied after an editor update.');
  }
}

function showStatusCmd(context: vscode.ExtensionContext): void {
  const mgr = manager(context);
  const state = getState(context);
  output.clear();
  output.appendLine('=== Pixel Scroll Terminal — Status ===');
  output.appendLine(`Editor:           ${vscode.env.appName}`);
  output.appendLine(`appRoot:          ${vscode.env.appRoot}`);
  output.appendLine(`Bundle layout:    ${mgr.layout()}`);
  output.appendLine(`Patch target:     ${mgr.location()}`);
  output.appendLine(`xterm version:    ${mgr.detectXtermVersion() ?? 'unknown'}`);
  output.appendLine(`Current snippet:  ${SNIPPET_VERSION}`);
  output.appendLine(`Stored state:     enabled=${state.enabled}, snippetVersion=${state.snippetVersion || '(none)'}`);
  output.appendLine('');
  for (const s of mgr.status()) {
    output.appendLine(
      `${s.kind.padEnd(4)} exists=${s.exists} anchor=${s.anchorCount} ` +
        `patched=${s.patched} version=${s.markerVersions.join(',') || '-'} current=${s.current}`
    );
    output.appendLine(`     ${s.path}`);
  }
  output.show(true);
}
