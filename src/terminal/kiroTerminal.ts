/**
 * Runs kiro-cli's own interactive chat in a VS Code terminal opened beside
 * the editor. The terminal process *is* kiro-cli (no intermediate shell), so
 * there is nothing OS-specific to pick beyond how the binary is launched.
 *
 * kiro-cli saves the conversation after every turn, so the main Kiro terminal
 * reopens the previous session (`--resume`) instead of starting over; see
 * the `kiro.chatSession` setting.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { CliManager, CLI_NOT_FOUND_MESSAGE } from '../cli/cliManager';
import { requiresShell } from '../cli/cliLocator';
import { KiroSession, SessionChoice, hasSessionFlag, pickSession, sessionArgs, sessionModeFromSetting } from './sessions';

export interface TerminalLaunch {
    shellPath: string;
    /** An array, or (Windows .cmd shims only) one pre-built command line. */
    shellArgs: string[] | string;
}

/**
 * Characters cmd.exe interprets even inside quotes. Only relevant when the
 * CLI is a .cmd/.bat shim, which has to run through cmd.exe.
 */
const CMD_METACHARACTERS = /["%^&|<>!]/g;

/** Quotes one argument for a cmd.exe command line (metacharacters already removed). */
function cmdQuote(arg: string): string {
    return /[\s']/.test(arg) || arg === '' ? `"${arg}"` : arg;
}

/**
 * Builds the terminal process for `kiro-cli <args>`.
 *
 * - Native binaries (kiro-cli.exe, kiro-cli) are the terminal process directly.
 * - Windows .cmd/.bat shims can't be started without cmd.exe, so they run via
 *   `cmd.exe /d /s /c ""<shim>" <args>"`. The command line is built here as a
 *   single string: with `/s`, cmd removes exactly the outer pair of quotes, so
 *   a shim path with spaces survives next to quoted arguments. Metacharacters
 *   are removed from the arguments so a prompt can't run other commands.
 */
export function buildTerminalLaunch(
    cliPath: string,
    args: string[],
    platform: NodeJS.Platform = process.platform,
    comSpec: string | undefined = process.env.ComSpec
): TerminalLaunch {
    if (requiresShell(cliPath, platform)) {
        const inner = [`"${cliPath}"`, ...args.map((a) => cmdQuote(a.replace(CMD_METACHARACTERS, '')))].join(' ');
        return { shellPath: comSpec || 'cmd.exe', shellArgs: `/d /s /c "${inner}"` };
    }
    return { shellPath: cliPath, shellArgs: args };
}

/**
 * Extra `kiro-cli chat` arguments from the `kiro.chatArguments` setting.
 * The setting is machine-scoped, so a repository's .vscode/settings.json
 * can't add flags such as --trust-all-tools.
 */
export function chatArgumentsFromSetting(): string[] {
    const value = vscode.workspace.getConfiguration('kiro').get<unknown>('chatArguments', []);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

/** kiro-cli chat flags that pick the agent engine. */
const ENGINE_FLAGS = new Set(['--v2', '--v3', '--agent-engine']);

/**
 * Adds `--v3` unless the arguments already choose an engine. Without a flag,
 * kiro-cli can still start V2 (a 2.0 user who hasn't picked an engine, a
 * `chat.agentEngine` of v2), so the extension asks for V3 explicitly.
 */
export function withV3Engine(args: string[]): string[] {
    const choosesEngine = args.some((a) => ENGINE_FLAGS.has(a) || a.startsWith('--agent-engine='));
    return choosesEngine ? args : ['--v3', ...args];
}

export interface StartOptions {
    /** Terminal tab title. */
    name?: string;
    /** First message for kiro-cli (`kiro-cli chat <prompt>`). */
    prompt?: string;
    /** Saved session to continue. Default: a new session. */
    session?: SessionChoice;
    /** Directory to run in. Default: the resolved working directory. */
    cwd?: string;
}

/** How the main terminal picks its session when it (re)starts. */
type SessionRequest =
    /** Follow `kiro.chatSession` (Open Chat). */
    | 'setting'
    /** Continue the latest session unless `kiro.chatSession` is "new" (restarts). */
    | 'continue'
    | SessionChoice;

/** How long to wait for a closed kiro-cli to exit before starting the next one. */
const EXIT_TIMEOUT_MS = 5000;
const EXIT_POLL_MS = 100;

/** True while the terminal's process (kiro-cli) hasn't exited. */
function isAlive(terminal: vscode.Terminal): boolean {
    return terminal.exitStatus === undefined;
}

/** True if a process with this ID still exists. */
function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM: it exists but belongs to someone else
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export class KiroTerminalManager implements vscode.Disposable {
    /** Terminals we started, with the directory each one runs in. */
    private readonly _terminals = new Map<vscode.Terminal, string>();
    /** The terminal `open()` reuses. */
    private _main: vscode.Terminal | undefined;
    /** De-duplicates concurrent `open()` calls (double click, folder picker open). */
    private _opening: Promise<vscode.Terminal | undefined> | undefined;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _cliManager: CliManager,
        private readonly _extensionUri: vscode.Uri
    ) {
        this._disposables.push(
            vscode.window.onDidCloseTerminal((t) => {
                this._terminals.delete(t);
                if (this._main === t) {
                    this._main = undefined;
                }
            })
        );
    }

    /** True while the main Kiro terminal is open and kiro-cli is still running in it. */
    get isRunning(): boolean {
        return this._main !== undefined && isAlive(this._main);
    }

    /** Directory the main Kiro terminal runs in, if kiro-cli is running there. */
    get runningDirectory(): string | undefined {
        return this.isRunning ? this._terminals.get(this._main!) : undefined;
    }

    /** Number of other (spec) Kiro terminals with kiro-cli still running. */
    get otherSessionCount(): number {
        return [...this._terminals.keys()].filter((t) => t !== this._main && isAlive(t)).length;
    }

    /**
     * Shows the main Kiro terminal, starting kiro-cli if it isn't running.
     * A new terminal opens the session `kiro.chatSession` asks for (by default
     * the latest one in the working directory). A terminal whose kiro-cli has
     * exited is replaced.
     */
    open(): Promise<vscode.Terminal | undefined> {
        if (this._main && isAlive(this._main)) {
            this._main.show();
            return Promise.resolve(this._main);
        }
        return this._replaceMain('setting');
    }

    /**
     * Closes the main Kiro terminal, waits for kiro-cli to exit, and starts it
     * again on the same conversation (the latest session in the working
     * directory), or a new one if `kiro.chatSession` is "new".
     */
    restart(): Promise<vscode.Terminal | undefined> {
        return this._replaceMain('continue');
    }

    /** Replaces the main Kiro terminal with a fresh conversation. */
    newChat(): Promise<vscode.Terminal | undefined> {
        return this._replaceMain({ kind: 'new' });
    }

    /**
     * Lets the user pick a saved session (or a new one) and opens it in the
     * main Kiro terminal. The open chat is kept if the picker is dismissed.
     */
    async resumeSession(): Promise<vscode.Terminal | undefined> {
        if (this._opening) {
            await this._opening;
        }
        const cwd = (await this._cliManager.resolveWorkingDirectory(true)).path;
        const sessions = await this._listSessions(cwd);
        if (sessions === undefined) {
            vscode.window.showErrorMessage('Could not read the saved kiro-cli sessions. See the "Kiro CLI" output channel for details.');
            return undefined;
        }
        const choice = await pickSession(sessions, cwd);
        if (!choice) {
            return undefined;
        }
        return this._replaceMain(choice, cwd);
    }

    /**
     * Closes the main terminal (if any) and starts a new one. Concurrent
     * calls share one launch.
     */
    private _replaceMain(request: SessionRequest, knownCwd?: string): Promise<vscode.Terminal | undefined> {
        const previous = this._opening ?? Promise.resolve(undefined);
        const opening = previous
            .catch(() => undefined)
            .then(async () => {
                // A concurrent Open Chat already started one
                if (request === 'setting' && this._main && isAlive(this._main)) {
                    this._main.show();
                    return this._main;
                }
                const cwd = knownCwd ?? (await this._cliManager.resolveWorkingDirectory(true)).path;
                const session = await this._resolveSession(request, cwd);
                if (session === undefined) {
                    return undefined; // picker dismissed
                }
                await this._closeMain();
                const terminal = await this.start({ session, cwd });
                this._main = terminal;
                return terminal;
            })
            .finally(() => {
                if (this._opening === opening) {
                    this._opening = undefined;
                }
            });
        this._opening = opening;
        return opening;
    }

    /**
     * Decides which session a new main terminal opens. Returns undefined if
     * the user dismissed the session picker.
     */
    private async _resolveSession(request: SessionRequest, cwd: string): Promise<SessionChoice | undefined> {
        if (typeof request !== 'string') {
            return request;
        }
        // The user's own --resume/--resume-id/... flags win
        if (hasSessionFlag(chatArgumentsFromSetting())) {
            return { kind: 'new' };
        }
        const mode = sessionModeFromSetting();
        if (mode === 'new') {
            return { kind: 'new' };
        }
        const sessions = await this._listSessions(cwd);
        // Nothing to continue in this directory (or the list is unreadable): start fresh
        if (!sessions?.length) {
            return { kind: 'new' };
        }
        if (mode === 'pick' && request === 'setting') {
            return pickSession(sessions, cwd);
        }
        // kiro-cli picks the newest session that has a conversation
        return { kind: 'resumeLast' };
    }

    /**
     * Saved sessions the next launch can open. A V3 chat (the default, see
     * `withV3Engine`) can't continue a V2 session, so those are left out.
     */
    private async _listSessions(cwd: string): Promise<KiroSession[] | undefined> {
        const sessions = await this._cliManager.listSessions(cwd);
        const v3 = withV3Engine(chatArgumentsFromSetting()).includes('--v3');
        return v3 ? sessions?.filter((s) => !s.source || s.source === 'v3') : sessions;
    }

    /**
     * Closes the main terminal and waits until its kiro-cli process has
     * exited, so the session it held is free to resume.
     */
    private async _closeMain(): Promise<void> {
        const old = this._main;
        this._main = undefined;
        if (!old) {
            return;
        }
        const pid = isAlive(old) ? await Promise.resolve(old.processId).catch(() => undefined) : undefined;
        this._terminals.delete(old);
        old.dispose();
        if (pid === undefined) {
            return;
        }
        const deadline = Date.now() + EXIT_TIMEOUT_MS;
        while (processExists(pid) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, EXIT_POLL_MS));
        }
    }

    /**
     * Starts a new kiro-cli chat terminal beside the editor. Returns undefined
     * (after telling the user) when the CLI can't be found.
     */
    async start(options: StartOptions = {}): Promise<vscode.Terminal | undefined> {
        const cliPath = this._cliManager.resolvedCliPath ?? (await this._cliManager.resolveCliPath());
        if (!cliPath) {
            vscode.window.showErrorMessage(CLI_NOT_FOUND_MESSAGE);
            return undefined;
        }
        const cwd = options.cwd ?? (await this._cliManager.resolveWorkingDirectory(true)).path;

        const args = ['chat', ...withV3Engine([...sessionArgs(options.session), ...chatArgumentsFromSetting()])];
        if (options.prompt) {
            args.push(options.prompt);
        }
        const launch = buildTerminalLaunch(cliPath, args);

        const terminal = vscode.window.createTerminal({
            name: options.name ?? `Kiro (${path.basename(cwd) || cwd})`,
            shellPath: launch.shellPath,
            shellArgs: launch.shellArgs,
            cwd,
            env: this._cliManager.terminalEnv(),
            iconPath: vscode.Uri.joinPath(this._extensionUri, 'resources', 'activitybar.svg'),
            location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            // Not revived after a reload: the extension couldn't track a revived
            // terminal, and a revived spec terminal would resend its first message.
            // The next Open Chat continues the saved session with --resume instead.
            isTransient: true,
        });
        this._terminals.set(terminal, cwd);
        terminal.show();
        return terminal;
    }

    dispose(): void {
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
        this._terminals.clear();
        this._main = undefined;
    }
}
