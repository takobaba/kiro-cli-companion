/**
 * Runs kiro-cli's own interactive chat in a VS Code terminal opened beside
 * the editor. The terminal process *is* kiro-cli (no intermediate shell), so
 * there is nothing OS-specific to pick beyond how the binary is launched.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { CliManager, CLI_NOT_FOUND_MESSAGE } from '../cli/cliManager';
import { requiresShell } from '../cli/cliLocator';

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

export interface StartOptions {
    /** Terminal tab title. */
    name?: string;
    /** First message for kiro-cli (`kiro-cli chat <prompt>`). */
    prompt?: string;
}

/** True while the terminal's process (kiro-cli) hasn't exited. */
function isAlive(terminal: vscode.Terminal): boolean {
    return terminal.exitStatus === undefined;
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
     * A terminal whose kiro-cli has exited is replaced with a fresh one.
     */
    open(): Promise<vscode.Terminal | undefined> {
        if (this._main && isAlive(this._main)) {
            this._main.show();
            return Promise.resolve(this._main);
        }
        if (!this._opening) {
            this._opening = (async () => {
                this._main?.dispose();
                this._main = undefined;
                const terminal = await this.start();
                this._main = terminal;
                return terminal;
            })().finally(() => {
                this._opening = undefined;
            });
        }
        return this._opening;
    }

    /** Closes the main Kiro terminal and starts a fresh kiro-cli session. */
    async restart(): Promise<vscode.Terminal | undefined> {
        if (this._opening) {
            await this._opening;
        }
        const old = this._main;
        this._main = undefined;
        old?.dispose();
        return this.open();
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
        const cwd = (await this._cliManager.resolveWorkingDirectory(true)).path;

        const args = ['chat', ...chatArgumentsFromSetting()];
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
            // kiro-cli saves the conversation; `kiro-cli chat --resume` continues it.
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
