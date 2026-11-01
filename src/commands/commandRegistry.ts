/**
 * CommandRegistry registers and guards VS Code commands for the Kiro extension.
 *
 * All commands are guarded: if the CLI state is `not_found`, an error
 * notification is shown with install instructions and the command returns early.
 */

import * as vscode from 'vscode';
import { CliManager, CLI_NOT_FOUND_MESSAGE } from '../cli/cliManager';
import { ChatPanelProvider } from '../chat/chatPanelProvider';
import { SpecWorkflowManager } from '../spec/specWorkflowManager';

export class CommandRegistry implements vscode.Disposable {
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _cliManager: CliManager,
        private readonly _chatPanelProvider: ChatPanelProvider,
        private readonly _specWorkflowManager: SpecWorkflowManager
    ) { }

    /**
     * Registers all extension commands and returns their disposables.
     * Each command is guarded against a missing CLI binary.
     */
    registerCommands(): vscode.Disposable[] {
        const commands: vscode.Disposable[] = [
            vscode.commands.registerCommand('kiro.openChat', () =>
                this._runIfCliAvailable(() => this._chatPanelProvider.openPanel())
            ),

            vscode.commands.registerCommand('kiro.startSpec', () =>
                this._runIfCliAvailable(() => this._specWorkflowManager.startWorkflow())
            ),

            // Return the promises so `executeCommand` callers can await completion
            vscode.commands.registerCommand('kiro.restartCli', () => this._handleRestartCli()),

            vscode.commands.registerCommand('kiro.login', () => this._handleLogin()),

            vscode.commands.registerCommand('kiro.selectWorkingDirectory', () => this._handleSelectWorkingDirectory()),
        ];

        this._disposables.push(...commands);
        return commands;
    }

    /**
     * Disposes of all registered command disposables.
     */
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
     * Runs synchronously in the common (CLI found) case.
     */
    private _runIfCliAvailable(action: () => void): void | Promise<void> {
        if (this._cliManager.state.status !== 'not_found') {
            action();
            return;
        }
        return this._cliManager.resolveCliPath().then(async (found) => {
            if (found) {
                action();
                return;
            }
            const choice = await vscode.window.showErrorMessage(CLI_NOT_FOUND_MESSAGE, 'Open Settings');
            if (choice === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'kiro.cliPath');
            }
        });
    }

    /**
     * Handles the Restart CLI command with authentication check and login flow.
     * Mirrors the PyCharm RestartCliAction behavior:
     * 1. Clear chat and show system messages
     * 2. Resolve CLI path
     * 3. Check authentication, attempt login if needed
     * 4. Restart the CLI process
     */
    private async _handleRestartCli(): Promise<void> {
        // Clear chat and show progress
        this._chatPanelProvider.postMessage({ type: 'clearChat' });
        this._chatPanelProvider.postMessage({
            type: 'systemMessage',
            message: 'Checking authentication...',
        });

        try {
            // Resolve CLI path
            const cliPath = await this._cliManager.resolveCliPath();
            if (!cliPath) {
                this._chatPanelProvider.postMessage({
                    type: 'error',
                    message: CLI_NOT_FOUND_MESSAGE,
                });
                return;
            }

            // Check authentication
            const isAuthenticated = await this._cliManager.checkAuthentication(cliPath);
            if (!isAuthenticated) {
                this._chatPanelProvider.postMessage({
                    type: 'systemMessage',
                    message: 'Not authenticated. Running kiro-cli login...',
                });

                const loginSuccess = await this._cliManager.login();
                if (!loginSuccess) {
                    this._chatPanelProvider.postMessage({
                        type: 'error',
                        message: 'Login failed. Please run \'kiro-cli login\' manually in your terminal.',
                    });
                    return;
                }

                this._chatPanelProvider.postMessage({
                    type: 'systemMessage',
                    message: 'Login successful. Starting CLI process...',
                });
            } else {
                this._chatPanelProvider.postMessage({
                    type: 'systemMessage',
                    message: 'Already authenticated. Starting CLI process...',
                });
            }

            // Restart the process
            await this._cliManager.restartProcess();

            this._chatPanelProvider.postMessage({
                type: 'systemMessage',
                message: 'CLI restarted. Ready for a new session.',
            });
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            this._chatPanelProvider.postMessage({
                type: 'error',
                message: `Failed to restart CLI: ${errorMessage}`,
            });
        }
    }

    /**
     * Lets the user choose the directory kiro-cli runs in. Restarts the CLI
     * (starting a fresh session) if it's running somewhere else.
     */
    private async _handleSelectWorkingDirectory(): Promise<void> {
        try {
            const wasRunning = this._cliManager.state.status === 'running';
            const dir = await this._cliManager.selectWorkingDirectory();
            if (!dir) {
                return;
            }
            this._chatPanelProvider.postMessage({
                type: 'systemMessage',
                message: wasRunning
                    ? `Working directory set to ${dir}. Started a new kiro-cli session there.`
                    : `Working directory set to ${dir}. kiro-cli will start there with your next message.`,
            });
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            this._chatPanelProvider.postMessage({
                type: 'error',
                message: `Failed to change working directory: ${errorMessage}`,
            });
        }
    }

    /**
     * Handles the Login command.
     */
    private async _handleLogin(): Promise<void> {
        try {
            this._chatPanelProvider.postMessage({
                type: 'systemMessage',
                message: 'Running kiro-cli login...',
            });

            const success = await this._cliManager.login();
            if (success) {
                this._chatPanelProvider.postMessage({
                    type: 'systemMessage',
                    message: 'Login successful.',
                });
                vscode.window.showInformationMessage('Kiro CLI authenticated successfully.');
            } else {
                this._chatPanelProvider.postMessage({
                    type: 'error',
                    message: 'Login failed. Please try running \'kiro-cli login\' manually.',
                });
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            vscode.window.showErrorMessage(`Kiro login failed: ${errorMessage}`);
        }
    }
}
