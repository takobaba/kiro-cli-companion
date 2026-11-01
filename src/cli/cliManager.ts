/**
 * CliManager manages CLI discovery, authentication verification, login,
 * and process lifecycle. It provides a single CLI process per workspace
 * with lazy spawning, started in a user-selectable working directory.
 */

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as pathModule from 'path';
import * as fs from 'fs';
import { CliProcess } from './cliProcess';
import { CliState, SessionInfo } from '../types';
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
    private _cliSource: string | null = null;
    private _process: CliProcess | null = null;
    private readonly _options: CliManagerOptions;
    private _isReconnecting = false;
    /** Working directory of the running process (or the last one chosen). */
    private _workingDirectory: ResolvedWorkingDirectory | null = null;
    /** De-duplicates concurrent multi-root pickers. */
    private _pendingPick: Promise<ResolvedWorkingDirectory> | null = null;
    /** De-duplicates concurrent spawns (panel open + first message). */
    private _pendingSpawn: Promise<CliProcess> | null = null;
    /** Kiro API key (from SecretStorage), passed as KIRO_API_KEY. */
    private _apiKey: string | undefined;

    /** Callback to post system messages during reconnect. */
    private _onSystemMessage: ((message: string) => void) | null = null;
    /** Callback to post error messages during reconnect. */
    private _onErrorMessage: ((message: string) => void) | null = null;

    private readonly _onDidChangeState = new vscode.EventEmitter<CliState>();
    public readonly onDidChangeState: vscode.Event<CliState> = this._onDidChangeState.event;

    constructor(options?: CliManagerOptions) {
        this._options = options ?? {};
    }

    /** Returns the current CLI state. */
    get state(): CliState {
        return this._state;
    }

    /** Returns the resolved CLI path, or null if not yet resolved. */
    get resolvedCliPath(): string | null {
        return this._resolvedCliPath;
    }

    /**
     * Best-known working directory without prompting: the running process's
     * cwd, else the last chosen one, else the non-interactive default.
     */
    get currentWorkingDirectory(): string {
        if (this._workingDirectory) {
            return this._workingDirectory.path;
        }
        return resolveWorkingDirectoryNonInteractive(this._options.workspaceState).path;
    }

    /** Snapshot of where/how kiro-cli is (or will be) running, for the UI. */
    getSessionInfo(): SessionInfo {
        const wd = this._workingDirectory ?? resolveWorkingDirectoryNonInteractive(this._options.workspaceState);
        const running = !!this._process && this._process.isAlive && this._state.status === 'running';
        return {
            cwd: wd.path,
            cwdSource: wd.source,
            cliPath: this._resolvedCliPath,
            cliSource: this._cliSource,
            running,
            sessionId: running ? this._process!.sessionId : null,
            multiRoot: (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
        };
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
     * Lets the user pick a new working directory. If it differs from the
     * running process's cwd, the CLI is restarted there.
     * Returns the new directory, or undefined if cancelled/unchanged.
     */
    async selectWorkingDirectory(): Promise<string | undefined> {
        const current = this.currentWorkingDirectory;
        const picked = await pickWorkingDirectory(current);
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

        const next = resolveWorkingDirectoryNonInteractive(this._options.workspaceState);
        const sameDir = this._samePath(next.path, this._workingDirectory?.path);
        this._workingDirectory = next;

        if (this._process && this._process.isAlive && !sameDir) {
            await this.restartProcess();
        } else {
            // Not running: just notify listeners so the UI updates
            this._setState(this._state);
        }
        return next.path;
    }

    /**
     * Sets (or clears) the Kiro API key passed to kiro-cli as KIRO_API_KEY.
     * Stored by the caller in SecretStorage; held here only in memory.
     */
    setApiKey(apiKey: string | undefined): void {
        this._apiKey = apiKey?.trim() || undefined;
    }

    /** Environment for kiro-cli child processes. */
    private _childEnv(): NodeJS.ProcessEnv {
        if (!this._apiKey) {
            return process.env;
        }
        return { ...process.env, KIRO_API_KEY: this._apiKey };
    }

    /**
     * Starts a fresh ACP session (clears conversation and slash-command state
     * such as /plan) on the running process, or spawns one if none is alive.
     */
    async newSession(): Promise<CliProcess> {
        if (this._process && this._process.isAlive && this._state.status === 'running') {
            const proc = this._process;
            await proc.createSession(proc.cwd);
            this._setState({ status: 'running', cliPath: proc.cliPath, process: proc, cwd: proc.cwd });
            return proc;
        }
        return this.ensureProcess();
    }

    /**
     * Sets callbacks for system/error messages during auto-reconnect.
     */
    setMessageCallbacks(
        onSystem: (message: string) => void,
        onError: (message: string) => void
    ): void {
        this._onSystemMessage = onSystem;
        this._onErrorMessage = onError;
    }

    /**
     * Resolves the CLI binary path. See `locateCli` for the search order
     * (setting → KIRO_CLI_PATH → PATH → Windows registry PATH → known
     * install locations). On Unix, falls back to sourcing shell profiles
     * (~/.zshrc, ~/.bashrc, ~/.bash_profile, ~/.profile).
     *
     * Returns null if the binary is not found.
     */
    async resolveCliPath(): Promise<string | null> {
        if (this._options.cliPath) {
            this._resolvedCliPath = this._options.cliPath;
            this._cliSource = 'override';
            this._setState({ status: 'ready', cliPath: this._resolvedCliPath });
            return this._resolvedCliPath;
        }

        const configuredPath = vscode.workspace.getConfiguration('kiro').get<string>('cliPath', '');
        const located = await locateCli({ configuredPath, log: (m) => _log.appendLine(m) });
        if (located) {
            _log.appendLine(`[CliManager] Found kiro-cli at ${located.path} (via ${located.source})`);
            return this._setResolved(located.path, located.source);
        }

        // On Unix, try sourcing shell profiles to get the full PATH
        if (process.platform !== 'win32') {
            const profilePath = await this._findViaShellProfile('kiro-cli');
            if (profilePath) {
                _log.appendLine(`[CliManager] Found kiro-cli at ${profilePath} (via shell profile)`);
                return this._setResolved(profilePath, 'shell profile');
            }
        }

        _log.appendLine('[CliManager] kiro-cli not found (checked kiro.cliPath, KIRO_CLI_PATH, PATH, known install locations).');
        this._resolvedCliPath = null;
        this._cliSource = null;
        this._setState({ status: 'not_found' });
        return null;
    }

    private _setResolved(cliPath: string, source: string): string {
        this._resolvedCliPath = cliPath;
        this._cliSource = source;
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
                    // Restore ready state with the CLI path
                    if (this._state.status !== 'running') {
                        this._setState({ status: 'ready', cliPath });
                    }
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
            execFile(target.command, ['login'], { timeout: 120000, env, shell: target.shell, windowsHide: true }, (error, _stdout, _stderr) => {
                if (!error) {
                    this._setState({ status: 'ready', cliPath });
                    resolve(true);
                } else {
                    // Check if already authenticated despite login exit code
                    this.checkAuthentication(cliPath).then((isAuth) => {
                        if (isAuth) {
                            this._setState({ status: 'ready', cliPath });
                            resolve(true);
                        } else {
                            resolve(false);
                        }
                    });
                }
            });
        });
    }

    /**
     * Spawns a CLI process if one isn't already alive. Reuses the existing
     * process if it's still running (lazy spawning).
     */
    async ensureProcess(options: { interactive?: boolean } = {}): Promise<CliProcess> {
        // A spawn is already in flight (e.g. panel open + first message) — share it
        if (this._pendingSpawn) {
            return this._pendingSpawn;
        }
        // Reuse existing process if alive and its session is ready
        if (this._process && this._process.isAlive && this._process.sessionId) {
            return this._process;
        }
        this._pendingSpawn = this._spawnProcess(options).finally(() => {
            this._pendingSpawn = null;
        });
        return this._pendingSpawn;
    }

    private async _spawnProcess(options: { interactive?: boolean }): Promise<CliProcess> {
        // Clean up dead / half-initialized process
        if (this._process) {
            const old = this._process;
            this._process = null;
            old.dispose();
        }

        // Determine CLI path, re-resolving if needed
        let cliPath = this._resolvedCliPath;
        if (!cliPath) {
            cliPath = await this.resolveCliPath();
            if (!cliPath) {
                throw new Error(CLI_NOT_FOUND_MESSAGE);
            }
        }

        // Re-use the directory the previous process ran in (e.g. on auto-reconnect),
        // otherwise resolve it — which may ask the user in a multi-root workspace.
        const workingDirectory = this._workingDirectory && fs.existsSync(this._workingDirectory.path)
            ? this._workingDirectory
            : await this.resolveWorkingDirectory(options.interactive ?? true);
        this._workingDirectory = workingDirectory;
        const workspacePath = workingDirectory.path;
        _log.appendLine(`[CliManager] Starting kiro-cli in ${workspacePath} (${workingDirectory.source})`);

        const cliProcess = new CliProcess(cliPath, workspacePath, this._childEnv());
        this._process = cliProcess;

        // Listen for unexpected exits
        cliProcess.onDidExit((exitInfo) => {
            if (this._process === cliProcess) {
                this._process = null;
                this._setState({ status: 'ready', cliPath: cliPath! });

                // Attempt auto-reconnect on unexpected exits
                const wasUnexpected = exitInfo.code !== 0 && exitInfo.code !== null;
                if (wasUnexpected && !this._isReconnecting) {
                    this._attemptAutoReconnect();
                }
            }
        });

        // Initialize ACP and create session; don't leave a half-started process around
        try {
            await cliProcess.initializeAndCreateSession(workspacePath);
        } catch (err) {
            if (this._process === cliProcess) {
                this._process = null;
            }
            cliProcess.dispose();
            throw err;
        }

        this._setState({ status: 'running', cliPath, process: cliProcess, cwd: workspacePath });
        return cliProcess;
    }

    /**
     * Terminates the current CLI process and spawns a new one.
     */
    async restartProcess(): Promise<CliProcess> {
        if (this._process) {
            const old = this._process;
            this._process = null;
            old.dispose();
        }

        // Re-resolve CLI path to handle environment changes
        await this.resolveCliPath();

        // Re-read the working directory in case the setting/choice changed
        const next = resolveWorkingDirectoryNonInteractive(this._options.workspaceState);
        if (!next.needsPick) {
            this._workingDirectory = next;
        }

        return this.ensureProcess();
    }

    /**
     * Gracefully terminates all CLI processes.
     * Sends SIGTERM first, then SIGKILL after 5 seconds if still alive.
     */
    dispose(): void {
        if (this._process) {
            const proc = this._process;
            this._process = null;

            // Send SIGTERM
            proc.kill();

            // Force kill after 5 seconds if still alive
            const killTimeout = setTimeout(() => {
                if (proc.isAlive) {
                    try {
                        proc.dispose();
                    } catch {
                        // Ignore errors during forced cleanup
                    }
                }
            }, 5000);

            // If the process exits before the timeout, clear it
            proc.onDidExit(() => {
                clearTimeout(killTimeout);
            });
        }

        this._onDidChangeState.dispose();
    }

    /**
     * Attempts to auto-reconnect with exponential backoff after an unexpected exit.
     * Makes 3 attempts with delays of 2s, 4s, 8s.
     */
    private async _attemptAutoReconnect(): Promise<void> {
        const MAX_ATTEMPTS = 3;
        const BASE_DELAY_MS = 2000;
        this._isReconnecting = true;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 2s, 4s, 8s

            this._onSystemMessage?.(
                `CLI process exited unexpectedly. Reconnect attempt ${attempt}/${MAX_ATTEMPTS} in ${delay / 1000}s...`
            );

            await new Promise<void>((resolve) => setTimeout(resolve, delay));

            try {
                await this.ensureProcess({ interactive: false });
                this._onSystemMessage?.('CLI reconnected successfully.');
                this._isReconnecting = false;
                return;
            } catch (err) {
                const msg = err instanceof Error ? err.message : 'Unknown error';
                this._onSystemMessage?.(`Reconnect attempt ${attempt} failed: ${msg}`);
            }
        }

        // All attempts failed
        this._isReconnecting = false;
        this._onErrorMessage?.(
            'Failed to reconnect after 3 attempts. Use "Kiro: Restart CLI" from the Command Palette to reconnect manually.'
        );
    }

    /**
     * Asks the user's login shell where the binary is, so PATH changes made in
     * ~/.zshrc, ~/.bashrc, ~/.profile etc. are honoured even when VS Code was
     * started from the Dock/launcher with a minimal environment.
     *
     * One interactive login shell (`-ilc`) loads the same profiles a terminal
     * would, in a single call with a single timeout.
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

    private _samePath(a: string | undefined, b: string | undefined): boolean {
        if (!a || !b) {
            return false;
        }
        const ra = pathModule.resolve(a);
        const rb = pathModule.resolve(b);
        return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
    }

    /**
     * Updates the internal state and fires the state change event.
     */
    private _setState(newState: CliState): void {
        this._state = newState;
        this._onDidChangeState.fire(newState);
    }
}
