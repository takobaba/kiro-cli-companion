/**
 * Extension entry point.
 *
 * Registers all commands and views first so they work immediately, then
 * locates kiro-cli and checks authentication in the background.
 */

import * as vscode from 'vscode';
import { CliManager, CLI_NOT_FOUND_MESSAGE } from './cli/cliManager';
import { ChatPanelProvider } from './chat/chatPanelProvider';
import { SpecWorkflowManager } from './spec/specWorkflowManager';
import { CommandRegistry } from './commands/commandRegistry';
import { KiroOverviewProvider } from './overview/overviewView';

/** SecretStorage key for the Kiro API key (passed to kiro-cli as KIRO_API_KEY). */
const API_KEY_SECRET = 'kiro.apiKey';

let cliManager: CliManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // workspaceState remembers the chosen working directory per workspace
    cliManager = new CliManager({ workspaceState: context.workspaceState });
    const manager = cliManager;

    // API key authentication: stored in SecretStorage, never in settings
    manager.setApiKey(await context.secrets.get(API_KEY_SECRET));

    const chatPanelProvider = new ChatPanelProvider(context.extensionUri, manager);
    const specWorkflowManager = new SpecWorkflowManager(manager, chatPanelProvider);
    chatPanelProvider.setSpecCallbacks(
        (content) => specWorkflowManager.capturePhaseContent(content),
        () => specWorkflowManager.advancePhase(),
        () => specWorkflowManager.saveCurrentPhase(),
        () => specWorkflowManager.cancelWorkflow()
    );
    // Messages typed during a spec revise the current document
    chatPanelProvider.setSpecSession(
        () => specWorkflowManager.isActive,
        (text) => specWorkflowManager.buildRevisionPrompt(text),
        () => specWorkflowManager.beginTurn()
    );

    // Sidebar: launcher buttons (welcome content of an empty view) and the
    // "What Kiro Uses" overview of rules, specs, agents, skills, MCP servers
    const overview = new KiroOverviewProvider(manager);
    chatPanelProvider.setRulesSource(() => overview.getConfig().rules);

    const commandRegistry = new CommandRegistry(manager, chatPanelProvider, specWorkflowManager);

    context.subscriptions.push(
        manager,
        chatPanelProvider,
        commandRegistry,
        overview,
        ...commandRegistry.registerCommands(),
        vscode.window.registerTreeDataProvider<vscode.TreeItem>('kiro.launcher', {
            getTreeItem: (item) => item,
            getChildren: () => [],
        }),
        vscode.window.registerTreeDataProvider('kiro.overview', overview),
        vscode.commands.registerCommand('kiro.newRule', () => overview.createRule()),
        vscode.commands.registerCommand('kiro.openRulesFolder', () => overview.openRulesFolder()),
        vscode.commands.registerCommand('kiro.refreshOverview', () => overview.refresh()),
        vscode.commands.registerCommand('kiro.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                title: 'Kiro: Set API Key',
                prompt: 'Paste a Kiro API key (generate one in the Kiro portal). It is stored in VS Code SecretStorage and passed to kiro-cli as KIRO_API_KEY.',
                password: true,
                ignoreFocusOut: true,
                validateInput: (v) => (v.trim() ? undefined : 'API key cannot be empty'),
            });
            if (!key) {
                return;
            }
            await context.secrets.store(API_KEY_SECRET, key.trim());
            manager.setApiKey(key.trim());
            await restartWithNewCredentials(manager, chatPanelProvider, 'API key saved.');
        }),
        vscode.commands.registerCommand('kiro.clearApiKey', async () => {
            await context.secrets.delete(API_KEY_SECRET);
            manager.setApiKey(undefined);
            await restartWithNewCredentials(manager, chatPanelProvider, 'API key removed. kiro-cli will use its own login.');
        }),
        context.secrets.onDidChange(async (e) => {
            if (e.key === API_KEY_SECRET) {
                manager.setApiKey(await context.secrets.get(API_KEY_SECRET));
            }
        }),
        // Re-detect the CLI when the user points kiro.cliPath somewhere else
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('kiro.cliPath')) {
                const found = await manager.resolveCliPath();
                if (found) {
                    vscode.window.showInformationMessage(`Kiro CLI found at ${found}.`);
                } else {
                    showCliNotFound();
                }
            }
        })
    );

    // Not awaited: notifications can stay open indefinitely and login can take
    // minutes, and commands must keep working meanwhile.
    void checkCliOnStartup(manager);
}

/** Locates kiro-cli and offers login if it isn't authenticated. */
async function checkCliOnStartup(manager: CliManager): Promise<void> {
    const cliPath = await manager.resolveCliPath();
    if (!cliPath) {
        showCliNotFound();
        return;
    }
    if (await manager.checkAuthentication(cliPath)) {
        return;
    }
    const action = await vscode.window.showWarningMessage(
        'Kiro CLI is not authenticated. Log in with your browser, or use a Kiro API key.',
        'Login',
        'Use API Key',
        'Dismiss'
    );
    if (action === 'Login') {
        await runLogin(manager);
    } else if (action === 'Use API Key') {
        await vscode.commands.executeCommand('kiro.setApiKey');
    }
}

function showCliNotFound(): void {
    vscode.window.showErrorMessage(CLI_NOT_FOUND_MESSAGE, 'Open Settings', 'Install Guide').then((action) => {
        if (action === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'kiro.cliPath');
        } else if (action === 'Install Guide') {
            vscode.env.openExternal(vscode.Uri.parse('https://kiro.dev/docs/cli/'));
        }
    });
}

async function runLogin(manager: CliManager): Promise<void> {
    try {
        if (await manager.login()) {
            vscode.window.showInformationMessage('Kiro CLI authenticated successfully.');
            return;
        }
    } catch {
        // fall through to the error below
    }
    vscode.window.showErrorMessage('Kiro login failed. Please run "kiro-cli login" manually in your terminal.');
}

/** Verifies the new credentials and restarts a running CLI so they take effect. */
async function restartWithNewCredentials(
    manager: CliManager,
    chatPanelProvider: ChatPanelProvider,
    message: string
): Promise<void> {
    const cliPath = manager.resolvedCliPath ?? await manager.resolveCliPath();
    if (!cliPath) {
        showCliNotFound();
        return;
    }
    const wasRunning = manager.state.status === 'running';
    if (!(await manager.checkAuthentication(cliPath))) {
        vscode.window.showWarningMessage(`${message} However, "kiro-cli whoami" still reports you are not authenticated.`);
        return;
    }
    if (wasRunning) {
        await manager.restartProcess();
        chatPanelProvider.postMessage({ type: 'systemMessage', message: `${message} Restarted kiro-cli with the new credentials.` });
    }
    vscode.window.showInformationMessage(`${message} Kiro CLI is authenticated.`);
}

export function deactivate(): void {
    // Terminates the CLI process
    cliManager?.dispose();
    cliManager = undefined;
}
