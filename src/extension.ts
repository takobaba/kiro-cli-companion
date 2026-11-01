/**
 * Extension entry point for the Kiro VS Code Extension.
 *
 * Handles activation (CLI discovery, authentication, component initialization)
 * and deactivation (graceful CLI shutdown).
 *
 * Requirements: 1.1–1.4, 2.1–2.4, 3.4
 */

import * as vscode from 'vscode';
import { CliManager, CLI_NOT_FOUND_MESSAGE } from './cli/cliManager';
import { WorkspaceContextProvider } from './context/workspaceContextProvider';
import { ChatPanelProvider } from './chat/chatPanelProvider';
import { SpecWorkflowManager } from './spec/specWorkflowManager';
import { CommandRegistry } from './commands/commandRegistry';
import { StatusManager } from './status/statusManager';
import { KiroOverviewProvider } from './overview/overviewView';

/** SecretStorage key for the Kiro API key (passed to kiro-cli as KIRO_API_KEY). */
const API_KEY_SECRET = 'kiro.apiKey';

let cliManager: CliManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // 1. Create CliManager (workspaceState remembers the chosen working directory)
    cliManager = new CliManager({ workspaceState: context.workspaceState });
    const manager = cliManager;

    // API key authentication: stored in SecretStorage, never in settings
    manager.setApiKey(await context.secrets.get(API_KEY_SECRET));
    context.subscriptions.push(
        context.secrets.onDidChange(async (e) => {
            if (e.key === API_KEY_SECRET) {
                manager.setApiKey(await context.secrets.get(API_KEY_SECRET));
            }
        })
    );

    // 2. Resolve CLI path — show error if not found (Req 1.1, 1.2, 1.3, 1.4)
    const cliPath = await manager.resolveCliPath();
    if (!cliPath) {
        showCliNotFound();
    }

    // 3. If CLI found, check authentication (Req 2.1, 2.2, 2.4)
    if (cliPath) {
        const isAuthenticated = await manager.checkAuthentication(cliPath);
        if (!isAuthenticated) {
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
    }

    // 4. Create WorkspaceContextProvider
    const contextProvider = new WorkspaceContextProvider();

    // 5. Create ChatPanelProvider
    const chatPanelProvider = new ChatPanelProvider(context.extensionUri, manager, contextProvider);

    // 6. Create SpecWorkflowManager
    const specWorkflowManager = new SpecWorkflowManager(manager, chatPanelProvider);

    // Wire up spec workflow callbacks
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

    // "Kiro" sidebar overview: rules, specs, agents, skills, MCP servers
    const overview = new KiroOverviewProvider(manager);
    chatPanelProvider.setRulesSource(() => overview.getConfig().rules);
    context.subscriptions.push(
        overview,
        vscode.window.registerTreeDataProvider('kiro.overview', overview),
        vscode.commands.registerCommand('kiro.newRule', () => overview.createRule()),
        vscode.commands.registerCommand('kiro.openRulesFolder', () => overview.openRulesFolder()),
        vscode.commands.registerCommand('kiro.refreshOverview', () => overview.refresh())
    );

    // 7. Create CommandRegistry and register commands
    const commandRegistry = new CommandRegistry(manager, chatPanelProvider, specWorkflowManager);

    // 8. Register commands and push disposables
    const commandDisposables = commandRegistry.registerCommands();
    context.subscriptions.push(...commandDisposables);

    context.subscriptions.push(
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

    // 9. Create StatusManager
    const statusManager = new StatusManager(manager);

    // Activity bar launcher. The view is intentionally empty so VS Code shows
    // its welcome content (buttons defined in package.json "viewsWelcome").
    // The chat itself still opens in an editor panel beside the code.
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider<vscode.TreeItem>('kiro.launcher', {
            getTreeItem: (item) => item,
            getChildren: () => [],
        })
    );

    // 10. Push all disposables to context.subscriptions
    context.subscriptions.push(manager);
    context.subscriptions.push(chatPanelProvider);
    context.subscriptions.push(commandRegistry);
    context.subscriptions.push(statusManager);
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
        const success = await manager.login();
        if (success) {
            vscode.window.showInformationMessage('Kiro CLI authenticated successfully.');
            return;
        }
    } catch {
        // fall through to the error below
    }
    vscode.window.showErrorMessage(
        'Kiro login failed. Please run "kiro-cli login" manually in your terminal.'
    );
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
    const ok = await manager.checkAuthentication(cliPath);
    if (!ok) {
        vscode.window.showWarningMessage(`${message} However, "kiro-cli whoami" still reports you are not authenticated.`);
        return;
    }
    if (wasRunning) {
        await manager.restartProcess();
        chatPanelProvider.postMessage({ type: 'systemMessage', message: `${message} Restarted kiro-cli with the new credentials.` });
    }
    vscode.window.showInformationMessage(`${message} Kiro CLI is authenticated.`);
}

export async function deactivate(): Promise<void> {
    // Graceful shutdown of CLI processes (Req 3.4)
    if (cliManager) {
        cliManager.dispose();
        cliManager = undefined;
    }
}
