/**
 * ChatPanelProvider manages the Webview chat panel lifecycle and message routing.
 *
 * Creates and manages a vscode.WebviewPanel with retainContextWhenHidden,
 * handles incoming messages from the Webview, sends ACP streaming requests
 * through the CLI, and forwards responses/errors back to the Webview.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { cliSpawnTarget } from '../cli/cliLocator';
import { CliManager } from '../cli/cliManager';
import { CliProcess, MODE_CONFIG_ID } from '../cli/cliProcess';
import { AppliedRule, Rule, formatRulesBlock, rulesToAttach } from '../rules/rules';
import type { ExtToWebviewMessage, WebviewToExtMessage, ContextUsage } from '../types';

const VIEW_TYPE = 'kiro.chatPanel';
const _log = vscode.window.createOutputChannel('Kiro Chat');

export class ChatPanelProvider implements vscode.Disposable {
    private _panel: vscode.WebviewPanel | undefined;
    private _lastFailedMessage: string | null = null;
    private readonly _disposables: vscode.Disposable[] = [];

    /** Current context usage data. */
    private _contextUsage: ContextUsage = { conversation: 0, mcpTools: 0, steeringFiles: 0, total: 0 };

    /** Callback for spec phase content capture. */
    private _specContentCapture: ((content: string) => void) | null = null;

    /** Callback for spec accept action. */
    private _onSpecAccept: (() => void) | null = null;

    /** Callback for spec save-only action. */
    private _onSpecSave: (() => void) | null = null;

    /** Callback for spec cancel action. */
    private _onSpecCancel: (() => void) | null = null;

    private _specIsActive: (() => boolean) | null = null;
    private _specBuildRevision: ((text: string) => string) | null = null;
    private _specBeginTurn: (() => void) | null = null;
    private _getRules: (() => Rule[]) | null = null;

    /**
     * Tracks the last known text editor so we can capture context even when
     * the webview panel has focus (which causes activeTextEditor to be null).
     */
    private _lastActiveTextEditor: vscode.TextEditor | undefined;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _cliManager: CliManager
    ) {
        // Seed with the current active editor
        this._lastActiveTextEditor = vscode.window.activeTextEditor;

        // Track editor changes — update our snapshot whenever a real text editor gains focus
        this._disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor) {
                    this._lastActiveTextEditor = editor;
                }
            })
        );

        // Wire up CLI manager message callbacks for auto-reconnect
        this._cliManager.setMessageCallbacks(
            (message) => this.postMessage({ type: 'systemMessage', message }),
            (message) => this.postMessage({ type: 'error', message })
        );

        // Keep the header's working-directory indicator in sync with the CLI
        this._disposables.push(
            this._cliManager.onDidChangeState((state) => {
                if (state.status === 'running') {
                    this._attachProcess(state.process);
                    const sessionId = state.process.sessionId ?? 'unknown';
                    this._postMessage({
                        type: 'systemMessage',
                        message: `Started "kiro-cli acp" in ${state.cwd} (session ${sessionId})`,
                    });
                }
                this._postSessionInfo();
            })
        );
    }

    /** Wires process callbacks and pushes its model/agent options to the webview. */
    private _attachProcess(cliProcess: CliProcess): void {
        cliProcess.onMetadata = (metadata) => this._handleMetadataNotification(metadata);
        cliProcess.onConfigOptionsChanged = (options, message) => {
            this._postMessage({ type: 'configOptions', options });
            if (message) {
                this._postMessage({ type: 'systemMessage', message });
            }
        };
        if (cliProcess.configOptions.length > 0) {
            this._postMessage({ type: 'configOptions', options: cliProcess.configOptions });
        }
    }

    /**
     * Starts kiro-cli in the background when the panel opens, so the header
     * shows the working directory, models and agents before the first message.
     */
    private async _warmUp(): Promise<void> {
        if (this._cliManager.state.status === 'not_found') {
            return;
        }
        try {
            const proc = await this._cliManager.ensureProcess();
            this._attachProcess(proc);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            _log.appendLine(`[Chat] Warm-up failed: ${message}`);
            this._postMessage({ type: 'error', message: `Could not start kiro-cli: ${message}` });
        }
        this._postSessionInfo();
    }

    /** Clears the chat and starts a fresh CLI session (resets /plan, /agent, history). */
    private async _clearAndStartNewSession(): Promise<void> {
        this._postMessage({ type: 'clearChat' });
        this._contextUsage = { conversation: 0, mcpTools: 0, steeringFiles: 0, total: 0 };
        this._postMessage({ type: 'contextUsage', usage: this._contextUsage });
        if (this._cliManager.state.status !== 'running') {
            return;
        }
        try {
            await this._cliManager.newSession();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._postMessage({ type: 'error', message: `Failed to start a new session: ${message}` });
        }
    }

    /** Sends the current working directory / CLI status to the webview header. */
    private _postSessionInfo(): void {
        if (!this._panel) {
            return;
        }
        this._postMessage({ type: 'sessionInfo', info: this._cliManager.getSessionInfo() });
    }

    /**
     * Sets callbacks for spec workflow integration.
     */
    setSpecCallbacks(
        onContentCapture: (content: string) => void,
        onAccept: () => void,
        onSave: () => void,
        onCancel: () => void
    ): void {
        this._specContentCapture = onContentCapture;
        this._onSpecAccept = onAccept;
        this._onSpecSave = onSave;
        this._onSpecCancel = onCancel;
    }

    /**
     * While a spec is in progress, messages typed in the chat are revisions of
     * the current document: they're rewritten by `buildRevision` and the reply
     * replaces the captured document (`beginTurn` resets the capture).
     */
    setSpecSession(isActive: () => boolean, buildRevision: (text: string) => string, beginTurn: () => void): void {
        this._specIsActive = isActive;
        this._specBuildRevision = buildRevision;
        this._specBeginTurn = beginTurn;
    }

    /** Supplies the current rule files so fileMatch/#manual rules can be attached. */
    setRulesSource(getRules: () => Rule[]): void {
        this._getRules = getRules;
    }

    /**
     * Opens or reveals the chat panel.
     * Creates a new panel if one doesn't exist, otherwise brings it to focus.
     * The panel occupies 1/4 of the editor width and files won't open in its column.
     */
    openPanel(): void {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }

        const groupsBefore = vscode.window.tabGroups.all.length;
        this._panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            'Kiro Chat',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._extensionUri],
            }
        );

        this._panel.webview.html = this._getWebviewContent();

        // Make the chat a narrow (1/4) column on the right — but only when the
        // user had a single editor group, so their own splits/sizes are kept.
        if (groupsBefore === 1) {
            setTimeout(() => {
                vscode.commands.executeCommand('vscode.setEditorLayout', {
                    orientation: 0,
                    groups: [{ size: 0.75 }, { size: 0.25 }],
                });
            }, 100);
        }

        // Prevent files from opening in the chat panel's column.
        this._panel.onDidChangeViewState(
            (e) => {
                if (!e.webviewPanel.active) {
                    const editor = vscode.window.activeTextEditor;
                    if (editor && editor.viewColumn === this._panel?.viewColumn) {
                        vscode.commands.executeCommand('workbench.action.moveEditorToFirstGroup');
                    }
                }
            },
            undefined,
            this._disposables
        );

        // Handle messages from the Webview
        this._panel.webview.onDidReceiveMessage(
            (message: WebviewToExtMessage) => this._onWebviewMessage(message),
            undefined,
            this._disposables
        );

        // Clean up when the panel is closed
        this._panel.onDidDispose(
            () => {
                this._panel = undefined;
            },
            undefined,
            this._disposables
        );
    }

    /**
     * Posts a typed message to the Webview from external components.
     * This is the public interface for sending messages to the chat panel,
     * used by SpecWorkflowManager, CommandRegistry, etc.
     */
    postMessage(message: ExtToWebviewMessage): void {
        this._postMessage(message);
    }

    /**
     * Sends a prompt through the CLI and streams the response to the Webview.
     * This is the core send method used by both regular messages and spec prompts.
     *
     * @param promptText The text to send (already enriched or raw)
     * @param isSpecPrompt If true, captures content for spec workflow
     */
    private async _sendPromptInternal(promptText: string, isSpecPrompt: boolean = false): Promise<void> {
        // Send loading start
        this._postMessage({ type: 'loading', active: true });
        // The reply to this turn becomes the spec document (replacing earlier drafts)
        if (isSpecPrompt) {
            this._specBeginTurn?.();
        }

        try {
            const cliProcess = await this._cliManager.ensureProcess();
            // Log size only — prompts can contain file contents
            _log.appendLine(`[Chat] Sending prompt (${promptText.length} chars)`);
            this._attachProcess(cliProcess);

            // Use the ACP session/prompt flow with session/update notifications
            await cliProcess.sendPrompt(promptText, (update) => {
                const sessionUpdate = update.sessionUpdate as string;

                if (sessionUpdate === 'agent_message_chunk') {
                    const content = update.content as { type: string; text?: string } | undefined;
                    if (content?.text) {
                        this._postMessage({ type: 'response', content: content.text, done: false });

                        // Capture content for spec workflow if active
                        if (isSpecPrompt) {
                            this._specContentCapture?.(content.text);
                        }
                    }
                } else if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
                    const title = update.title as string | undefined;
                    const status = update.status as string | undefined;
                    const kind = update.kind as string | undefined;
                    if (title) {
                        _log.appendLine(`[Chat] Tool: ${title} [${status || ''}]`);
                        this._postMessage({ type: 'toolStatus', title, status: status || '', kind: kind || '' });
                    }
                } else if (sessionUpdate === 'context_usage') {
                    this._handleContextUsageUpdate(update);
                }
            });

            _log.appendLine(`[Chat] Prompt completed`);
            this._postMessage({ type: 'response', content: '', done: true });
            this._lastFailedMessage = null;
        } catch (err) {
            const rawMessage = err instanceof Error ? err.message : 'An unknown error occurred';
            const errorCode = (err as { code?: number } | undefined)?.code;
            _log.appendLine(`[Chat] Error: ${rawMessage}${errorCode !== undefined ? ` (code ${errorCode})` : ''}`);

            const isSessionError =
                rawMessage.includes('terminated unexpectedly') ||
                rawMessage.includes('not authenticated') ||
                rawMessage.includes('not running') ||
                rawMessage.includes('stdin is not writable') ||
                rawMessage.includes('not alive');

            // JSON-RPC -32603 "Internal error" usually means the CLI session is in a
            // bad state (e.g. expired credentials); retrying on the same session keeps
            // failing, but restarting the CLI fixes it.
            const isInternalError = errorCode === -32603 || /internal error/i.test(rawMessage);

            const displayMessage = isSessionError
                ? 'Session expired or CLI process is not running. Please use \'Kiro: Restart CLI\' from the Command Palette to reconnect.'
                : isInternalError
                    ? `kiro-cli reported an internal error (${rawMessage}). Its session may be stale — click "Restart CLI" to start a fresh one.`
                    : rawMessage;

            this._postMessage({ type: 'error', message: displayMessage });
            this._lastFailedMessage = promptText;

            const actions = isSessionError || isInternalError ? ['Retry', 'Restart CLI'] : ['Retry'];
            const action = await vscode.window.showErrorMessage(
                `Communication error: ${displayMessage}`,
                ...actions
            );
            if (action === 'Retry') {
                this._sendPromptInternal(promptText, isSpecPrompt);
            } else if (action === 'Restart CLI') {
                vscode.commands.executeCommand('kiro.restartCli');
            }
        } finally {
            this._postMessage({ type: 'loading', active: false });
        }
    }

    /**
     * Sends a user message through the CLI and streams the response to the Webview.
     * Prepends active file context before sending.
     */
    async handleUserMessage(text: string): Promise<void> {
        if (!this._panel) {
            return;
        }
        // Slash commands (/agent, /plan, /context, …) must reach kiro-cli as the
        // very first characters, otherwise they're sent to the model as plain
        // text. Send them without editor context.
        const isSlashCommand = text.trimStart().startsWith('/');
        if (isSlashCommand) {
            await this._sendPromptInternal(text.trim(), false);
            return;
        }

        // Rules kiro-cli doesn't load itself: fileMatch (active file) and #manual
        const applied = this._rulesForMessage(text);
        if (applied.length) {
            this._postMessage({
                type: 'systemMessage',
                message: `📏 Applying rules: ${applied.map((a) => `${a.rule.name} (${a.reason})`).join(', ')}`,
            });
        }
        const rulesBlock = formatRulesBlock(applied);

        const inSpec = this._specIsActive?.() === true && this._specBuildRevision !== null;
        const body = inSpec ? this._specBuildRevision!(text) : this._buildContextEnrichedPrompt(text);
        await this._sendPromptInternal(rulesBlock ? `${rulesBlock}\n\n${body}` : body, inSpec);
    }

    /** fileMatch rules matching the active file, plus manual rules referenced as #name. */
    private _rulesForMessage(text: string): AppliedRule[] {
        if (!this._getRules) {
            return [];
        }
        let activeRelative: string | null = null;
        const editor = this._lastActiveTextEditor;
        if (editor && !editor.document.isClosed && editor.document.uri.scheme === 'file') {
            const rel = path.relative(this._cliManager.currentWorkingDirectory, editor.document.uri.fsPath);
            activeRelative = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
                ? rel
                : vscode.workspace.asRelativePath(editor.document.uri, false);
        }
        try {
            return rulesToAttach(this._getRules(), text, activeRelative);
        } catch (err) {
            _log.appendLine(`[Chat] Failed to evaluate rules: ${err}`);
            return [];
        }
    }

    /**
     * Sends a spec workflow prompt through the CLI WITHOUT prepending editor context.
     * Shows a system message instead of the full prompt as a user bubble.
     * Captures streaming content for the spec manager.
     * Ensures the panel is open and ready before sending.
     */
    async handleSpecPrompt(prompt: string, phaseLabel: string): Promise<void> {
        // openPanel() creates the panel synchronously, so it exists right after
        this.openPanel();
        this._postMessage({ type: 'systemMessage', message: `Generating ${phaseLabel}...` });
        await this._sendPromptInternal(prompt, true);
    }

    /**
     * Disposes of the panel and all associated resources.
     */
    dispose(): void {
        this._panel?.dispose();
        this._panel = undefined;

        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables.length = 0;
    }

    /**
     * Builds a prompt enriched with active file context and selected text.
     *
     * Uses _lastActiveTextEditor instead of vscode.window.activeTextEditor
     * because when the user types in the webview, the webview has focus and
     * activeTextEditor returns null. We track the last real text editor
     * separately to avoid this.
     */
    private _buildContextEnrichedPrompt(userText: string): string {
        const editor = this._lastActiveTextEditor;
        if (!editor || editor.document.isClosed) {
            return userText;
        }

        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

        const parts: string[] = [];

        if (selectedText.trim()) {
            // User has highlighted code
            parts.push(`[Active file: ${filePath}]`);
            parts.push(`[Selected code in ${path.basename(filePath)}:]`);
            parts.push('```');
            parts.push(selectedText);
            parts.push('```');
        } else {
            // No selection — include file path and content
            const content = editor.document.getText();
            parts.push(`[Active file: ${filePath}]`);
            // Include file content if it's reasonably sized (< 10k chars)
            if (content.length > 0 && content.length < 10000) {
                parts.push(`[Content of ${path.basename(filePath)}:]`);
                parts.push('```');
                parts.push(content);
                parts.push('```');
            }
        }

        parts.push(userText);
        return parts.join('\n');
    }

    /**
     * Routes incoming Webview messages to the appropriate handler.
     */
    private _onWebviewMessage(message: WebviewToExtMessage): void {
        switch (message.type) {
            case 'sendMessage':
                this.handleUserMessage(message.text);
                break;
            case 'retry':
                // Re-send the last failed message if available
                if (this._lastFailedMessage !== null) {
                    this.handleUserMessage(this._lastFailedMessage);
                }
                break;
            case 'selectModel':
                // Handle model selection from the webview
                this._handleModelSelection(message.configId, message.value);
                break;
            case 'specAccept':
                this._onSpecAccept?.();
                break;
            case 'specSave':
                this._onSpecSave?.();
                break;
            case 'specCancel':
                this._onSpecCancel?.();
                break;
            case 'startSpec':
                vscode.commands.executeCommand('kiro.startSpec');
                break;
            case 'clearChat':
                // Clear the UI and reset the CLI session so modes like /plan don't linger
                this._clearAndStartNewSession();
                break;
            case 'ready':
                // Webview script loaded — send the header info it missed and start the CLI
                this._postSessionInfo();
                this._warmUp();
                break;
            case 'changeWorkingDirectory':
                vscode.commands.executeCommand('kiro.selectWorkingDirectory');
                break;
        }
    }

    /**
     * Handles `_kiro.dev/metadata` notifications from the CLI.
     * Parses contextUsagePercentage and sends it to the webview.
     */
    private _handleMetadataNotification(metadata: Record<string, unknown>): void {
        const contextUsagePercentage = metadata.contextUsagePercentage as number | undefined;
        if (contextUsagePercentage !== undefined) {
            this._contextUsage = {
                ...this._contextUsage,
                total: contextUsagePercentage,
            };
            this._postMessage({ type: 'contextUsage', usage: this._contextUsage });
        }
    }

    /**
     * Handles context_usage data from session/update notifications.
     */
    private _handleContextUsageUpdate(update: Record<string, unknown>): void {
        const conversation = (update.conversation as number) ?? this._contextUsage.conversation;
        const mcpTools = (update.mcpTools as number) ?? this._contextUsage.mcpTools;
        const steeringFiles = (update.steeringFiles as number) ?? this._contextUsage.steeringFiles;
        const total = (update.total as number) ?? this._contextUsage.total;

        this._contextUsage = { conversation, mcpTools, steeringFiles, total };
        this._postMessage({ type: 'contextUsage', usage: this._contextUsage });
    }

    /**
     * Handles model selection from the webview.
     * Tries ACP protocol first, falls back to kiro-cli settings command.
     */
    private async _handleModelSelection(configId: string, value: string): Promise<void> {
        try {
            const cliProcess = await this._cliManager.ensureProcess();

            // Try ACP protocol first (session/set_model, session/set_mode, or set_config_option)
            const label = configId === MODE_CONFIG_ID ? 'Agent' : 'Model';
            try {
                const updated = await cliProcess.setConfigOption(configId, value);
                this._postMessage({ type: 'configOptions', options: updated });
                this._postMessage({ type: 'systemMessage', message: `${label} changed to ${value}` });
                return;
            } catch (acpErr) {
                _log.appendLine(`[Chat] ACP option change failed: ${acpErr}`);
                if (configId === MODE_CONFIG_ID) {
                    throw acpErr;
                }
            }

            // Fallback for models only: change the CLI's default model
            const cliPath = this._cliManager.resolvedCliPath;
            if (cliPath) {
                await this._setModelViaCli(cliPath, value);
            } else {
                this._postMessage({ type: 'error', message: 'CLI not found. Cannot change model.' });
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            this._postMessage({ type: 'error', message: `Failed to change model: ${errorMessage}` });
        }
    }

    /**
     * Sets the model using kiro-cli settings command as a fallback.
     */
    private _setModelViaCli(cliPath: string, modelValue: string): Promise<void> {
        return new Promise<void>((resolve) => {
            const target = cliSpawnTarget(cliPath);
            execFile(target.command, ['settings', 'chat.defaultModel', modelValue], { timeout: 10000, shell: target.shell, windowsHide: true }, (error: Error | null, _stdout: string, stderr: string) => {
                if (error) {
                    this._postMessage({ type: 'error', message: `Failed to change model: ${stderr || error.message}` });
                } else {
                    this._postMessage({ type: 'systemMessage', message: `Default model set to ${modelValue} (applies to new sessions)` });
                }
                resolve();
            });
        });
    }

    /**
     * Posts a typed message to the Webview.
     */
    private _postMessage(message: ExtToWebviewMessage): void {
        this._panel?.webview.postMessage(message);
    }

    /**
     * Builds the Webview HTML content by loading the template from disk
     * and injecting proper webview URIs for CSS/JS and a CSP nonce.
     *
     * In production the webview assets live under dist/webview/ (copied by
     * copy-webpack-plugin). During development they live under src/chat/webview/.
     * We try dist/webview/ first and fall back to src/chat/webview/.
     */
    private _getWebviewContent(): string {
        const webview = this._panel!.webview;

        // Resolve webview directory — prefer dist/webview (production), fall back to src/chat/webview (dev)
        const distWebviewPath = path.join(this._extensionUri.fsPath, 'dist', 'webview');
        const srcWebviewPath = path.join(this._extensionUri.fsPath, 'src', 'chat', 'webview');
        const useDistPath = fs.existsSync(path.join(distWebviewPath, 'index.html'));
        const webviewFsPath = useDistPath ? distWebviewPath : srcWebviewPath;
        const webviewDir = useDistPath
            ? vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview')
            : vscode.Uri.joinPath(this._extensionUri, 'src', 'chat', 'webview');

        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'styles.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js'));
        const nonce = this._getNonce();

        const htmlPath = path.join(webviewFsPath, 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf-8');

        html = html.replace(/\{\{stylesUri\}\}/g, stylesUri.toString());
        html = html.replace(/\{\{scriptUri\}\}/g, scriptUri.toString());
        html = html.replace(/\{\{nonce\}\}/g, nonce);
        html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);

        return html;
    }

    /**
     * Generates a cryptographically random nonce for the Content Security Policy.
     */
    private _getNonce(): string {
        return randomBytes(16).toString('base64');
    }
}
