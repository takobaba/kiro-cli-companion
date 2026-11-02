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
import { randomBytes } from 'crypto';
import { CliManager } from '../cli/cliManager';
import { ACP_ARGS, CliProcess, MODE_CONFIG_ID, PermissionDecision, PermissionRequest } from '../cli/cliProcess';
import { AppliedRule, Rule, formatRulesBlock, rulesToAttach } from '../rules/rules';
import { BUILTIN_COMMANDS, parseSlashCommand } from './slashCommands';
import type { ConsentScope, ExtToWebviewMessage, WebviewToExtMessage, ContextUsage } from '../types';

const VIEW_TYPE = 'kiro.chatPanel';
const _log = vscode.window.createOutputChannel('Kiro Chat');

/** A turn is either a prompt for kiro-cli or a client-side action (e.g. a slash command). */
type Turn = { prompt: string; isSpecPrompt: boolean } | { action: () => Promise<void> };

export class ChatPanelProvider implements vscode.Disposable {
    private _panel: vscode.WebviewPanel | undefined;
    /** Last prompt that failed, exactly as it was sent (already enriched). */
    private _lastFailed: { prompt: string; isSpecPrompt: boolean } | null = null;
    private readonly _disposables: vscode.Disposable[] = [];
    /** Permission cards waiting for the user, by request ID. */
    private readonly _pendingPermissions = new Map<string, { request: PermissionRequest; scopes: ConsentScope[]; resolve: (d: PermissionDecision) => void }>();
    private _permissionCounter = 0;

    /**
     * Prompt queue. kiro-cli handles one turn at a time, so — like the CLI's
     * own chat — messages sent while Kiro is working wait for the current turn
     * to finish. Every turn is chained onto `_turnChain`.
     */
    private _turnChain: Promise<void> = Promise.resolve();
    /** Turns that are running or waiting to run. */
    private _pendingTurns = 0;
    /** Bumped to discard everything still waiting (clear chat, failed turn). */
    private _queueGeneration = 0;
    /**
     * True once a message was sent in this conversation. The working directory
     * is fixed from then on; clearing the chat starts a new conversation.
     */
    private _conversationStarted = false;
    /** Set by the Stop button (or clear chat) while a turn runs; reset when the next turn starts. */
    private _stopRequested = false;
    /** Bumped when the chat is cleared, so a turn from the old chat stays quiet. */
    private _chatEpoch = 0;

    /** True when the working directory can no longer change for this conversation. */
    get isWorkingDirectoryLocked(): boolean {
        return this._conversationStarted;
    }

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
                        message: `Started "kiro-cli ${ACP_ARGS.join(' ')}" in ${state.cwd} (session ${sessionId})`,
                    });
                }
                this._postSessionInfo();
            })
        );
    }

    /** Wires process callbacks and pushes its model/agent options to the webview. */
    private _attachProcess(cliProcess: CliProcess): void {
        cliProcess.onContextUsage = (usage) => {
            this._contextUsage = usage;
            this._postMessage({ type: 'contextUsage', usage });
        };
        cliProcess.onPermissionRequest = (request) => this._askPermission(request);
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
     * Shows a permission card with the options kiro-cli offered and waits for
     * the user. Without a chat panel nobody can answer, so the call is denied.
     */
    private _askPermission(request: PermissionRequest): Promise<PermissionDecision> {
        if (!this._panel) {
            const reject = request.options.find((o) => o.kind === 'reject_once');
            return Promise.resolve(reject ? { optionId: reject.optionId } : { cancelled: true });
        }
        // Asked after Stop was pressed: the turn is ending, so don't show a new card
        if (this._stopRequested) {
            return Promise.resolve({ cancelled: true });
        }
        const requestId = `perm-${++this._permissionCounter}`;
        // Workspace rules need a workspace root from kiro-cli; user rules apply everywhere
        const scopes: ConsentScope[] = request.consent?.workspaceRoot ? ['workspace', 'user', 'session'] : ['user', 'session'];
        this._panel.reveal(undefined, true);
        this._postMessage({
            type: 'permissionRequest',
            request: {
                requestId,
                title: request.title,
                capability: request.consent?.capability,
                resource: request.consent?.triggeringResource ?? request.consent?.resource,
                options: request.options,
                scopes,
            },
        });
        return new Promise<PermissionDecision>((resolve) => {
            this._pendingPermissions.set(requestId, { request, scopes, resolve });
        });
    }

    /** Applies the user's answer from a permission card. */
    private _answerPermission(requestId: string, optionId: string, scope?: ConsentScope): void {
        const pending = this._pendingPermissions.get(requestId);
        if (!pending) {
            return;
        }
        this._pendingPermissions.delete(requestId);
        const option = pending.request.options.find((o) => o.optionId === optionId);
        if (!option) {
            pending.resolve({ cancelled: true });
            this._postMessage({ type: 'permissionResolved', requestId, label: 'Cancelled' });
            return;
        }
        const isAlways = option.kind === 'allow_always' || option.kind === 'reject_always';
        // Only accept a scope this card actually offered
        if (scope !== undefined && !pending.scopes.includes(scope)) {
            scope = undefined;
        }
        const where = scope === 'workspace' ? ' (this workspace)' : scope === 'user' ? ' (all projects)' : scope === 'session' ? ' (this session)' : '';
        pending.resolve({ optionId, scope: isAlways ? scope : undefined });
        this._postMessage({ type: 'permissionResolved', requestId, label: `${option.name}${isAlways ? where : ''}` });
    }

    /** Cancels every open permission card (chat cleared, panel closed). */
    private _cancelPendingPermissions(): void {
        for (const [requestId, pending] of this._pendingPermissions) {
            pending.resolve({ cancelled: true });
            this._postMessage({ type: 'permissionResolved', requestId, label: 'Cancelled' });
        }
        this._pendingPermissions.clear();
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
        // Queued messages belong to the conversation being cleared
        this._discardQueuedTurns();
        // So does a tool waiting for approval
        this._cancelPendingPermissions();
        this._chatEpoch++;
        // And a reply still being written: cancel it on the old session, before
        // newSession() replaces it, so new messages don't wait behind it
        if (this._pendingTurns > 0) {
            this._stopRequested = true;
            if (this._cliManager.state.status === 'running') {
                this._cliManager.state.process.cancel();
            }
        }
        // A new conversation may start in a different folder
        this._conversationStarted = false;
        this._postSessionInfo();
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
        this._postMessage({
            type: 'sessionInfo',
            info: { ...this._cliManager.getSessionInfo(), locked: this._conversationStarted },
        });
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
                this._cancelPendingPermissions();
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
     * Runs a turn after every earlier turn has finished.
     *
     * `build` is called when the turn actually starts, so it sees state left
     * by earlier turns (e.g. the spec document a revision applies to). It may
     * return null to skip the turn. Returns when this turn has finished.
     *
     * @param queueId Webview bubble ID, so the webview can show it as queued.
     */
    private _enqueueTurn(
        build: () => Turn | null,
        queueId?: string
    ): Promise<void> {
        const generation = this._queueGeneration;
        const waits = this._pendingTurns > 0;
        if (!this._conversationStarted) {
            this._conversationStarted = true;
            this._postSessionInfo();
        }
        this._pendingTurns++;
        if (waits && queueId) {
            this._postMessage({ type: 'messageQueued', id: queueId });
        }

        const turn = this._turnChain.then(async () => {
            try {
                if (generation !== this._queueGeneration) {
                    if (queueId) {
                        this._postMessage({ type: 'messageDropped', id: queueId });
                    }
                    return;
                }
                if (waits && queueId) {
                    this._postMessage({ type: 'messageDequeued', id: queueId });
                }
                // Once per turn, so a Stop during a slash command's setup
                // (e.g. "/model x then text") also skips the prompt that follows
                this._stopRequested = false;
                const next = build();
                if (!next) {
                    return;
                }
                if ('action' in next) {
                    await next.action();
                    return;
                }
                await this._sendPromptInternal(next.prompt, next.isSpecPrompt);
            } finally {
                this._pendingTurns--;
            }
        });
        this._turnChain = turn.catch((err) => _log.appendLine(`[Chat] Turn failed: ${err}`));
        return turn;
    }

    /** Drops turns that haven't started yet. The running turn is unaffected. */
    private _discardQueuedTurns(reason?: string): void {
        this._queueGeneration++;
        // Turns still waiting = all pending minus the one currently running
        const waiting = Math.max(0, this._pendingTurns - 1);
        if (reason && waiting > 0) {
            this._postMessage({
                type: 'systemMessage',
                message: `${waiting} queued message${waiting === 1 ? ' was' : 's were'} not sent ${reason}.`,
            });
        }
    }

    /**
     * Stop button: cancels the running turn and drops queued messages, so
     * Kiro actually stops instead of moving on to the next one.
     */
    private _stop(): void {
        if (this._pendingTurns === 0) {
            return;
        }
        this._stopRequested = true;
        this._discardQueuedTurns('because you stopped Kiro');
        // ACP: open permission requests must be answered "cancelled"
        this._cancelPendingPermissions();
        if (this._cliManager.state.status === 'running') {
            this._cliManager.state.process.cancel();
        }
    }

    /** Resolves once no turn is running or queued (including ones queued meanwhile). */
    async whenIdle(): Promise<void> {
        let chain: Promise<void>;
        do {
            chain = this._turnChain;
            await chain;
            // Let follow-ups queued from callbacks (e.g. Retry) register
            await new Promise<void>((r) => setImmediate(r));
        } while (chain !== this._turnChain || this._pendingTurns > 0);
    }

    /**
     * Sends a prompt through the CLI and streams the response to the Webview.
     * Only call through `_enqueueTurn` — kiro-cli runs one turn at a time.
     *
     * @param promptText The text to send (already enriched or raw)
     * @param isSpecPrompt If true, captures content for spec workflow
     */
    private async _sendPromptInternal(promptText: string, isSpecPrompt: boolean = false): Promise<void> {
        const epoch = this._chatEpoch;
        // Stopped before this prompt was reached (e.g. during a slash command's setup)
        if (this._stopRequested) {
            if (epoch === this._chatEpoch) {
                this._postMessage({ type: 'systemMessage', message: 'Stopped.' });
            }
            return;
        }
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

            // Stopped while kiro-cli was still starting: don't send at all
            if (this._stopRequested) {
                this._postMessage({ type: 'response', content: '', done: true });
                if (epoch === this._chatEpoch) {
                    this._postMessage({ type: 'systemMessage', message: 'Stopped.' });
                }
                return;
            }

            // Use the ACP session/prompt flow with session/update notifications
            const result = await cliProcess.sendPrompt(promptText, (update) => {
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
                    const toolCallId = update.toolCallId as string | undefined;
                    // Updates may carry only an ID and a status (no title)
                    if (title || (toolCallId && status)) {
                        _log.appendLine(`[Chat] Tool: ${title ?? toolCallId} [${status || ''}]`);
                        this._postMessage({ type: 'toolStatus', title: title || '', status: status || '', kind: kind || '', toolCallId });
                    }
                }
            });

            _log.appendLine(`[Chat] Prompt completed (${String(result.stopReason ?? 'end_turn')})`);
            this._postMessage({ type: 'response', content: '', done: true });
            if ((result.stopReason === 'cancelled' || this._stopRequested) && epoch === this._chatEpoch) {
                this._postMessage({ type: 'systemMessage', message: 'Stopped.' });
            }
            this._lastFailed = null;
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
            this._lastFailed = { prompt: promptText, isSpecPrompt };
            // Don't fire queued follow-ups at a broken session. Done before the
            // notification so a Retry from it isn't discarded too.
            this._discardQueuedTurns('because the previous message failed');

            // Don't await the notification: it would hold up the queue until dismissed
            const actions = isSessionError || isInternalError ? ['Retry', 'Restart CLI'] : ['Retry'];
            void Promise.resolve(vscode.window.showErrorMessage(
                `Communication error: ${displayMessage}`,
                ...actions
            )).then((action) => {
                if (action === 'Retry') {
                    this._retryLastFailed();
                } else if (action === 'Restart CLI') {
                    vscode.commands.executeCommand('kiro.restartCli');
                }
            });
        } finally {
            this._postMessage({ type: 'loading', active: false });
        }
    }

    /** Re-sends the last failed prompt as-is (it already carries its context). */
    private _retryLastFailed(): Promise<void> | undefined {
        const failed = this._lastFailed;
        if (!failed) {
            return undefined;
        }
        this._lastFailed = null;
        return this._enqueueTurn(() => failed);
    }

    /**
     * Sends a user message through the CLI and streams the response to the Webview.
     * Prepends active file context before sending. If Kiro is still working on
     * an earlier message, this one is queued and sent when that turn ends.
     *
     * @param queueId Webview bubble ID used to show the message as queued
     */
    async handleUserMessage(text: string, queueId?: string): Promise<void> {
        if (!this._panel) {
            return;
        }
        // Slash commands: CLI V3 has no generic command API, so each one is
        // routed here (see slashCommands.ts). They're sent without editor context.
        if (text.trimStart().startsWith('/')) {
            const command = text.trim();
            if (/^\/clear\b/i.test(command)) {
                // Like the 🗑 button: also drops queued messages, so don't queue it
                await this._clearAndStartNewSession();
                return;
            }
            return this._enqueueTurn(() => ({ action: () => this._runSlashCommand(command) }), queueId);
        }

        // Editor context and rules are captured now — what the user was looking
        // at when they typed — even if the message waits in the queue.
        const applied = this._rulesForMessage(text);
        if (applied.length) {
            this._postMessage({
                type: 'systemMessage',
                message: `📏 Applying rules: ${applied.map((a) => `${a.rule.name} (${a.reason})`).join(', ')}`,
            });
        }
        const rulesBlock = formatRulesBlock(applied);
        const enriched = this._buildContextEnrichedPrompt(text);
        const withRules = (body: string) => (rulesBlock ? `${rulesBlock}\n\n${body}` : body);

        return this._enqueueTurn(() => {
            // Spec revisions are built when the turn starts, against the latest draft
            const inSpec = this._specIsActive?.() === true && this._specBuildRevision !== null;
            return inSpec
                ? { prompt: withRules(this._specBuildRevision!(text)), isSpecPrompt: true }
                : { prompt: withRules(enriched), isSpecPrompt: false };
        }, queueId);
    }

    /**
     * Runs a slash command (as a queued turn, so it sees the session as left
     * by earlier messages).
     */
    private async _runSlashCommand(command: string): Promise<void> {
        let proc: CliProcess;
        try {
            proc = await this._cliManager.ensureProcess();
            this._attachProcess(proc);
        } catch (err) {
            this._postMessage({ type: 'error', message: `Could not start kiro-cli: ${err instanceof Error ? err.message : String(err)}` });
            return;
        }
        const advertised = proc.availableCommands ?? [];
        const action = parseSlashCommand(command, advertised.map((c) => c.name));
        if (!action) {
            return;
        }
        const say = (message: string) => this._postMessage({ type: 'systemMessage', message });

        switch (action.kind) {
            case 'agentCommand':
                await this._sendPromptInternal(action.text, false);
                return;
            case 'clear':
                await this._clearAndStartNewSession();
                return;
            case 'help': {
                const lines = BUILTIN_COMMANDS.map((c) => `${c.usage} — ${c.description}`);
                if (advertised.length) {
                    lines.push('', 'From kiro-cli:', ...advertised.map((c) => `/${c.name}${c.hint ? ` <${c.hint}>` : ''} — ${firstSentence(c.description)}`));
                }
                say(lines.join('\n'));
                return;
            }
            case 'setOption': {
                const option = proc.configOptions.find((o) => o.id === action.configId);
                if (!option) {
                    say(`kiro-cli doesn't offer a ${action.label.toLowerCase()} setting for this session${action.configId === 'effortLevel' ? ' (the current model may not support effort levels)' : ''}.`);
                    return;
                }
                if (!action.value) {
                    const current = option.options.find((o) => o.value === option.currentValue);
                    say(`${action.label}: ${current?.name ?? option.currentValue}\nAvailable: ${option.options.map((o) => o.value).join(', ')}`);
                    return;
                }
                const wanted = action.value.toLowerCase();
                const choice = option.options.find((o) => o.value.toLowerCase() === wanted || o.name.toLowerCase() === wanted);
                if (!choice) {
                    say(`Unknown ${action.label.toLowerCase()} "${action.value}". Available: ${option.options.map((o) => o.value).join(', ')}`);
                    return;
                }
                if (choice.value !== option.currentValue) {
                    await this._handleModelSelection(action.configId, choice.value);
                }
                if (action.then) {
                    await this._sendPromptInternal(this._buildContextEnrichedPrompt(action.then), false);
                } else if (choice.value === option.currentValue) {
                    say(`${action.label} is already ${choice.name}.`);
                }
                return;
            }
            case 'context':
                say(`Context window: ${Math.round(this._contextUsage.total)}% used`);
                return;
            case 'compact':
                if (!proc.hasExtensionMethod('_kiro/session/compact')) {
                    say('This kiro-cli doesn\'t support /compact.');
                    return;
                }
                this._postMessage({ type: 'loading', active: true });
                try {
                    await proc.request('_kiro/session/compact', { sessionId: proc.sessionId });
                    say('Conversation compacted.');
                } catch (err) {
                    this._postMessage({ type: 'error', message: `Compact failed: ${err instanceof Error ? err.message : String(err)}` });
                } finally {
                    this._postMessage({ type: 'loading', active: false });
                }
                return;
            case 'permissions':
                await vscode.commands.executeCommand('kiro.openPermissions');
                return;
            case 'unknown':
                say(`Unknown command /${action.name}. Type /help for the list.`);
                return;
        }
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
        await this._enqueueTurn(() => ({ prompt, isSpecPrompt: true }));
    }

    /**
     * Disposes of the panel and all associated resources.
     */
    dispose(): void {
        this._cancelPendingPermissions();
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
                this.handleUserMessage(message.text, message.id);
                break;
            case 'retry':
                // Re-send the last failed prompt if available
                this._retryLastFailed();
                break;
            case 'stop':
                this._stop();
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
            case 'permissionResponse':
                this._answerPermission(message.requestId, message.optionId, message.scope);
                break;
        }
    }

    /**
     * Changes an advertised session option (model, mode, effort) through
     * `session/set_config_option`.
     */
    private async _handleModelSelection(configId: string, value: string): Promise<void> {
        const label = configId === MODE_CONFIG_ID ? 'Mode' : configId === 'model' ? 'Model' : configId;
        try {
            const cliProcess = await this._cliManager.ensureProcess();
            const updated = await cliProcess.setConfigOption(configId, value);
            this._postMessage({ type: 'configOptions', options: updated });
            const option = updated.find((o) => o.id === configId);
            const name = option?.options.find((o) => o.value === value)?.name ?? value;
            this._postMessage({ type: 'systemMessage', message: `${label} changed to ${name}` });
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            _log.appendLine(`[Chat] set_config_option ${configId} failed: ${errorMessage}`);
            this._postMessage({ type: 'error', message: `Failed to change ${label.toLowerCase()}: ${errorMessage}` });
            // Put the selector back to what kiro-cli actually uses
            if (this._cliManager.state.status === 'running') {
                this._postMessage({ type: 'configOptions', options: this._cliManager.state.process.configOptions });
            }
        }
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
        const markdownUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'markdown.js'));
        const nonce = this._getNonce();

        const htmlPath = path.join(webviewFsPath, 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf-8');

        html = html.replace(/\{\{stylesUri\}\}/g, stylesUri.toString());
        html = html.replace(/\{\{scriptUri\}\}/g, scriptUri.toString());
        html = html.replace(/\{\{markdownUri\}\}/g, markdownUri.toString());
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

/** First sentence of a (possibly long) command description, for /help. */
function firstSentence(text: string): string {
    const m = /^[^.!?\n]*[.!?]?/.exec(text.trim());
    const s = (m?.[0] ?? '').trim();
    return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}
