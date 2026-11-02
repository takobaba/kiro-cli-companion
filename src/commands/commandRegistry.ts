/**
 * CommandRegistry registers the Kiro chat, spec, restart, login and
 * working-directory commands.
 *
 * Commands that need the CLI are guarded: if it can't be found, discovery is
 * re-run and an error with a link to the setting is shown if it's still missing.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { CliManager, CLI_NOT_FOUND_MESSAGE } from '../cli/cliManager';
import { SpecWorkflowManager } from '../spec/specWorkflowManager';
import { KiroTerminalManager } from '../terminal/kiroTerminal';

export class CommandRegistry implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _cliManager: CliManager,
        private readonly _terminals: KiroTerminalManager,
        private readonly _specWorkflowManager: SpecWorkflowManager
    ) { }

    /** Registers all extension commands and returns their disposables. */
    registerCommands(): vscode.Disposable[] {
        // Handlers return their promises so `executeCommand` callers can await them
        const commands: vscode.Disposable[] = [
            vscode.commands.registerCommand('kiro.openChat', () =>
                this._runIfCliAvailable(() => this._terminals.open())
            ),
            vscode.commands.registerCommand('kiro.startSpec', () =>
                this._runIfCliAvailable(() => this._specWorkflowManager.startWorkflow())
            ),
            vscode.commands.registerCommand('kiro.restartCli', () => this._handleRestartCli()),
            vscode.commands.registerCommand('kiro.login', () => this._handleLogin()),
            vscode.commands.registerCommand('kiro.selectWorkingDirectory', () => this._handleSelectWorkingDirectory()),
        ];

        this._disposables.push(...commands);
        return commands;
    }

    dispose(): void {
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
    }

    /**
     * Runs `action` if the CLI is available. When it's missing, re-runs
     * discovery first so installing the CLI or fixing kiro.cliPath works
     * without a window reload; shows an error if it's still not found.
     */
    private async _runIfCliAvailable(action: () => Promise<unknown>): Promise<void> {
        if (this._cliManager.state.status === 'not_found' && !(await this._cliManager.resolveCliPath())) {
            const choice = await vscode.window.showErrorMessage(CLI_NOT_FOUND_MESSAGE, 'Open Settings');
            if (choice === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'kiro.cliPath');
            }
            return;
        }
        await action();
    }

    /**
     * Re-detects the CLI, logs in if needed, then replaces the Kiro terminal
     * with a fresh kiro-cli session.
     */
    private async _handleRestartCli(): Promise<void> {
        try {
            const cliPath = await this._cliManager.resolveCliPath();
            if (!cliPath) {
                vscode.window.showErrorMessage(CLI_NOT_FOUND_MESSAGE);
                return;
            }
            if (!(await this._cliManager.checkAuthentication(cliPath)) && !(await this._cliManager.login())) {
                vscode.window.showErrorMessage('Kiro login failed. Please run "kiro-cli login" manually in your terminal.');
                return;
            }
            await this._terminals.restart();
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to restart Kiro CLI: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
    }

    /**
     * Lets the user choose the directory kiro-cli runs in. A running session
     * belongs to the folder it started in, so offer to restart it there.
     */
    private async _handleSelectWorkingDirectory(): Promise<void> {
        try {
            const dir = await this._cliManager.selectWorkingDirectory();
            if (!dir) {
                return;
            }
            const running = this._terminals.runningDirectory;
            if (running === undefined || samePath(running, dir)) {
                vscode.window.showInformationMessage(`Kiro will start in ${dir}.`);
                return;
            }
            const choice = await vscode.window.showInformationMessage(
                `Kiro will start in ${dir} from now on. The open Kiro chat is still working in ${running}.`,
                'Restart Chat There',
                'Keep Current Chat'
            );
            if (choice === 'Restart Chat There') {
                await this._terminals.restart();
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to change working directory: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
    }

    private async _handleLogin(): Promise<void> {
        try {
            if (await this._cliManager.login()) {
                vscode.window.showInformationMessage('Kiro CLI authenticated successfully.');
            } else {
                vscode.window.showErrorMessage('Kiro login failed. Please run "kiro-cli login" manually in your terminal.');
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Kiro login failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
    }
}

function samePath(a: string, b: string): boolean {
    const ra = path.resolve(a);
    const rb = path.resolve(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}
