/**
 * CliManager handles CLI discovery, authentication checks, login, the
 * directory kiro-cli starts in, and the environment it starts with.
 * The chat itself runs in a terminal (see terminal/kiroTerminal.ts).
 */

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as pathModule from 'path';
import { CliState } from '../types';
import { cliSpawnTarget, getHomeDir, isExecutableFile, locateCli } from './cliLocator';
import {
    ResolvedWorkingDirectory,
    WORKING_DIRECTORY_STATE_KEY,
    pickWorkingDirectory,
    resolveWorkingDirectoryNonInteractive,
} from './workingDirectory';

const _log = vscode.window.createOutputChannel('Kiro CLI');

/** Shown whenever kiro-cli can't be located. Platform-aware. */
export const CLI_NOT_FOUND_MESSAGE =
    process.platform === 'win32'
        ? 'Kiro CLI (kiro-cli.exe) not found. Install it from https://kiro.dev, or set "kiro.cliPath" ' +
          '(or the KIRO_CLI_PATH environment variable) to its full path, e.g. ' +
          '%LOCALAPPDATA%\\Kiro-Cli\\kiro-cli.exe. See the "Kiro CLI" output channel for details.'
        : 'Kiro CLI (kiro-cli) not found. Install it from https://kiro.dev and ensure ~/.local/bin is on your PATH, ' +
          'or set "kiro.cliPath" to its full path. See the "Kiro CLI" output channel for details.';

export interface CliManagerOptions {
    /** Override CLI path for testing. */
    cliPath?: string;
    /** Used to remember the chosen working directory per workspace. */
    workspaceState?: vscode.Memento;
}

export class CliManager implements vscode.Disposable {
    private _state: CliState = { status: 'not_found' };
    private _resolvedCliPath: string | null = null;
    private readonly _options: CliManagerOptions;
    /** De-duplicates concurrent multi-root pickers. */
    private _pendingPick: Promise<ResolvedWorkingDirectory> | null = null;
    /** Kiro API key (from SecretStorage), passed as KIRO_API_KEY. */
    private _apiKey: string | undefined;

    private readonly _onDidChangeState = new vscode.EventEmitter<CliState>();
    /** Fires on CLI state changes and when the working directory changes. */
    public readonly onDidChangeState: vscode.Event<CliState> = this._onDidChangeState.event;

    constructor(options?: CliManagerOptions) {
        this._options = options ?? {};
    }

    get state(): CliState {
        return this._state;
    }

    /** Returns the resolved CLI path, or null if not yet resolved. */
    get resolvedCliPath(): string | null {
        return this._resolvedCliPath;
    }

    /** The directory kiro-cli starts in, resolved without prompting. */
    get currentWorkingDirectory(): string {
        return resolveWorkingDirectoryNonInteractive(this._options.workspaceState).path;
    }

    /**
     * Resolves the directory kiro-cli should start in. In a multi-root
     * workspace with no saved choice, asks the user once (when interactive).
     */
    async resolveWorkingDirectory(interactive: boolean): Promise<ResolvedWorkingDirectory> {
        const resolved = resolveWorkingDirectoryNonInteractive(this._options.workspaceState, (m) => _log.appendLine(m));
        if (!resolved.needsPick || !interactive) {
            return resolved;
        }
        if (!this._pendingPick) {
            this._pendingPick = (async () => {
                const picked = await pickWorkingDirectory(resolved.path);
                if (picked) {
                    await this._options.workspaceState?.update(WORKING_DIRECTORY_STATE_KEY, picked);
                    this._setState(this._state);
                    return { path: picked, source: 'picked' as const };
                }
                // Dismissed: use the default for now, ask again next time
                return { path: resolved.path, source: resolved.source };
            })().finally(() => {
                this._pendingPick = null;
            });
        }
        return this._pendingPick;
    }

    /**
     * Lets the user pick a new working directory for future kiro-cli sessions.
     * Returns the effective directory, or undefined if cancelled.
     */
    async selectWorkingDirectory(): Promise<string | undefined> {
        const picked = await pickWorkingDirectory(this.currentWorkingDirectory);
        if (!picked) {
            return undefined;
        }
        await this._options.workspaceState?.update(WORKING_DIRECTORY_STATE_KEY, picked);

        const setting = vscode.workspace.getConfiguration('kiro').get<string>('workingDirectory', '').trim();
        if (setting) {
            vscode.window.showWarningMessage(
                `"kiro.workingDirectory" is set to "${setting}" and takes precedence over this choice. ` +
                'Clear the setting to use the picked directory.'
            );
        }
        // Lets the overview follow the new directory
        this._setState(this._state);
        return this.currentWorkingDirectory;
    }

    /**
     * Sets (or clears) the Kiro API key passed to kiro-cli as KIRO_API_KEY.
     * Stored by the caller in SecretStorage; held here only in memory.
     */
    setApiKey(apiKey: string | undefined): void {
        this._apiKey = apiKey?.trim() || undefined;
    }

    /** Extra environment for kiro-cli terminals (merged into VS Code's own). */
    terminalEnv(): Record<string, string> {
        return this._apiKey ? { KIRO_API_KEY: this._apiKey } : {};
    }

    /** Environment for kiro-cli child processes (whoami, login). */
    private _childEnv(): NodeJS.ProcessEnv {
        return { ...process.env, ...this.terminalEnv() };
    }

    /**
     * Resolves the CLI binary path. See `locateCli` for the search order
     * (setting → KIRO_CLI_PATH → PATH → Windows registry PATH → known
     * install locations). On Unix, falls back to asking the login shell.
     *
     * Returns null if the binary is not found.
     */
    async resolveCliPath(): Promise<string | null> {
        if (this._options.cliPath) {
            return this._setResolved(this._options.cliPath);
        }

        const configuredPath = vscode.workspace.getConfiguration('kiro').get<string>('cliPath', '');
        const located = await locateCli({ configuredPath, log: (m) => _log.appendLine(m) });
        if (located) {
            _log.appendLine(`[CliManager] Found kiro-cli at ${located.path} (via ${located.source})`);
            return this._setResolved(located.path);
        }

        // On Unix, try the login shell to get the full PATH
        if (process.platform !== 'win32') {
            const profilePath = await this._findViaShellProfile('kiro-cli');
            if (profilePath) {
                _log.appendLine(`[CliManager] Found kiro-cli at ${profilePath} (via shell profile)`);
                return this._setResolved(profilePath);
            }
        }

        _log.appendLine('[CliManager] kiro-cli not found (checked kiro.cliPath, KIRO_CLI_PATH, PATH, known install locations).');
        this._resolvedCliPath = null;
        this._setState({ status: 'not_found' });
        return null;
    }

    private _setResolved(cliPath: string): string {
        this._resolvedCliPath = cliPath;
        this._setState({ status: 'ready', cliPath });
        return cliPath;
    }

    /**
     * Checks if the CLI has valid authentication credentials by running
     * `kiro-cli whoami`. Returns true if authenticated, false otherwise.
     */
    async checkAuthentication(cliPath: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const target = cliSpawnTarget(cliPath);
            execFile(target.command, ['whoami'], { timeout: 10000, shell: target.shell, windowsHide: true, env: this._childEnv() }, (error, _stdout, stderr) => {
                if (error) {
                    _log.appendLine(`[CliManager] whoami failed: ${error.message}${stderr ? ` — ${stderr.trim()}` : ''}`);
                    this._setState({ status: 'not_authenticated' });
                    resolve(false);
                } else {
                    this._setState({ status: 'ready', cliPath });
                    resolve(true);
                }
            });
        });
    }

    /**
     * Runs `kiro-cli login` to authenticate the user via browser-based OAuth.
     * Returns true if login succeeded, false otherwise.
     */
    async login(): Promise<boolean> {
        const cliPath = this._resolvedCliPath ?? await this.resolveCliPath();
        if (!cliPath) {
            throw new Error('CLI binary not found. Please install kiro-cli.');
        }

        return new Promise<boolean>((resolve) => {
            const env: Record<string, string | undefined> = { ...process.env };
            // GUI-launched editors on macOS/Linux may lack HOME/XDG_CONFIG_HOME.
            // Not applied on Windows, where kiro-cli uses its own config location.
            if (process.platform !== 'win32') {
                const home = getHomeDir();
                if (home) {
                    env.HOME = home;
                    if (!process.env.XDG_CONFIG_HOME) {
                        env.XDG_CONFIG_HOME = pathModule.join(home, '.config');
                    }
                }
            }

            const target = cliSpawnTarget(cliPath);
            execFile(target.command, ['login'], { timeout: 120000, env, shell: target.shell, windowsHide: true }, (error) => {
                if (!error) {
                    this._setState({ status: 'ready', cliPath });
                    resolve(true);
                    return;
                }
                // Check if already authenticated despite login exit code
                this.checkAuthentication(cliPath).then(resolve);
            });
        });
    }

    dispose(): void {
        this._onDidChangeState.dispose();
    }

    /**
     * Asks the user's login shell where the binary is, so PATH changes made in
     * ~/.zshrc, ~/.bashrc, ~/.profile etc. are honoured even when VS Code was
     * started from the Dock/launcher with a minimal environment.
     */
    private async _findViaShellProfile(binary: string): Promise<string | null> {
        if (!/^[\w.-]+$/.test(binary)) {
            return null; // never interpolate anything unexpected into a shell command
        }
        const shell = process.env.SHELL || '/bin/bash';
        return new Promise<string | null>((resolve) => {
            execFile(shell, ['-ilc', `command -v ${binary}`], { timeout: 8000 }, (_error, stdout) => {
                // Profiles may print banners; take the last line that is a real executable
                const candidate = (stdout || '')
                    .split('\n')
                    .map((l) => l.trim())
                    .reverse()
                    .find((l) => pathModule.isAbsolute(l) && isExecutableFile(l));
                resolve(candidate ?? null);
            });
        });
    }

    private _setState(newState: CliState): void {
        this._state = newState;
        this._onDidChangeState.fire(newState);
    }
}
