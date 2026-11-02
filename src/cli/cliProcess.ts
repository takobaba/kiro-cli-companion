/**
 * CliProcess wraps a single `kiro-cli acp --agent-engine=v3` child process,
 * handling ACP framing (newline-delimited JSON-RPC 2.0) over stdin/stdout.
 *
 * Lifecycle: initialize → session/new → session/prompt, with session/update
 * notifications streaming the turn. The agent can also send requests to us
 * (session/request_permission), which always get a response.
 *
 * Written against the CLI V3 ACP server; see
 * https://kiro.dev/docs/cli/v3/acp-migration/
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import type { AcpResponse, ConfigOption, ConsentScope, ContextUsage, PermissionOption } from '../types';
import { cliSpawnTarget } from './cliLocator';

/** Shared output channel for ACP protocol debugging */
const _log = vscode.window.createOutputChannel('Kiro ACP');

/** Arguments that start the CLI V3 ACP server. Auth uses the `kiro-cli login` session (or KIRO_API_KEY). */
export const ACP_ARGS = ['acp', '--agent-engine=v3'];

/** Config option IDs advertised by kiro-cli V3. */
export const MODEL_CONFIG_ID = 'model';
export const MODE_CONFIG_ID = 'mode';

interface ExitInfo {
    code: number | null;
    signal: string | null;
}

interface PendingRequest {
    resolve: (response: AcpResponse) => void;
    reject: (error: Error) => void;
}

/** Consent context kiro-cli V3 attaches to a permission request (`_meta.kiro.consent`). */
export interface ConsentContext {
    capability?: string;
    resource?: string;
    triggeringResource?: string;
    workspaceRoot?: string;
    /** "explicit" means a rule asked; an allow rule can't be saved for it. */
    askType?: string;
    persistableConsent?: boolean;
}

/** A `session/request_permission` from the agent. */
export interface PermissionRequest {
    sessionId: string;
    toolCallId?: string;
    /** Human-readable title. Display only — never use it to decide. */
    title: string;
    options: PermissionOption[];
    consent?: ConsentContext;
}

/** The user's answer. `scope` is used for "always" options only. */
export type PermissionDecision = { optionId: string; scope?: ConsentScope } | { cancelled: true };

/** A command the agent can run when sent as `/name args` (from available_commands_update). */
export interface AvailableCommand {
    name: string;
    description: string;
    hint?: string;
}

/**
 * Builds the JSON-RPC result for a permission request. Returns only an option
 * the agent offered; "always" options carry canonical consent metadata so
 * kiro-cli can save the rule in the chosen scope (it defaults to the session).
 */
export function buildPermissionResult(request: PermissionRequest, decision: PermissionDecision): Record<string, unknown> {
    if ('cancelled' in decision) {
        return { outcome: { outcome: 'cancelled' } };
    }
    const option = request.options.find((o) => o.optionId === decision.optionId);
    if (!option) {
        // Never synthesize an option the agent didn't offer
        return { outcome: { outcome: 'cancelled' } };
    }
    const result: Record<string, unknown> = { outcome: { outcome: 'selected', optionId: option.optionId } };
    const isAlways = option.kind === 'allow_always' || option.kind === 'reject_always';
    const consent = request.consent;
    if (isAlways && consent) {
        const resource = consent.triggeringResource ?? consent.resource;
        result._meta = {
            kiro: {
                consent: {
                    scope: decision.scope ?? 'session',
                    ...(resource ? { resource } : {}),
                    ...(consent.workspaceRoot ? { workspaceRoot: consent.workspaceRoot } : {}),
                },
            },
        };
    }
    return result;
}

/** Converts a V3 `session_info_update` (kind `context_usage`) into the header's usage numbers. */
export function parseContextUsage(kiro: Record<string, unknown>): ContextUsage | null {
    const total = typeof kiro.usagePercentage === 'number'
        ? kiro.usagePercentage
        : (kiro.contextUsage as { usagePercentage?: number } | undefined)?.usagePercentage;
    if (typeof total !== 'number') {
        return null;
    }
    const b = (kiro.breakdown ?? {}) as Record<string, { percent?: number; mcp?: { percent?: number } } | undefined>;
    const pct = (v: { percent?: number } | undefined) => (typeof v?.percent === 'number' ? v.percent : 0);
    return {
        total,
        conversation: pct(b.yourPrompts) + pct(b.kiroResponses),
        mcpTools: pct(b.tools?.mcp),
        steeringFiles: pct(b.contextFiles),
    };
}

export class CliProcess implements vscode.Disposable {
    private readonly _process: ChildProcess;
    private _alive: boolean = false;
    private readonly _pendingRequests = new Map<string, PendingRequest>();
    private _stdoutBuffer: string = '';
    private _sessionId: string | null = null;
    /** Sessions replaced by "Clear chat"; their late updates are ignored. */
    private readonly _retiredSessions = new Set<string>();
    private _onSessionUpdate: ((update: Record<string, unknown>) => void) | null = null;
    private _onConfigOptionsChanged: ((options: ConfigOption[], message?: string) => void) | null = null;
    private _onContextUsage: ((usage: ContextUsage) => void) | null = null;
    private _onPermissionRequest: ((request: PermissionRequest) => Promise<PermissionDecision>) | null = null;
    private _requestCounter = 0;
    private _configOptions: ConfigOption[] = [];
    private _extensionMethods: string[] = [];
    private _availableCommands: AvailableCommand[] = [];

    private readonly _onDidExit = new vscode.EventEmitter<ExitInfo>();
    public readonly onDidExit: vscode.Event<ExitInfo> = this._onDidExit.event;

    /** Directory the CLI process was started in. */
    public readonly cwd: string;
    /** Path of the kiro-cli binary this process runs. */
    public readonly cliPath: string;

    constructor(cliPath: string, workspacePath: string, env?: NodeJS.ProcessEnv) {
        this.cwd = workspacePath;
        this.cliPath = cliPath;
        const target = cliSpawnTarget(cliPath);
        _log.appendLine(`[CliProcess] Spawning: ${cliPath} ${ACP_ARGS.join(' ')} (cwd: ${workspacePath}${target.shell ? ', via shell' : ''})`);
        this._process = spawn(target.command, ACP_ARGS, {
            cwd: workspacePath,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: target.shell,
            windowsHide: true,
            env: env ?? process.env,
        });
        this._alive = true;

        this._process.stdout?.on('data', (data: Buffer) => {
            this._handleStdoutData(data.toString());
        });

        this._process.stderr?.on('data', (data: Buffer) => {
            _log.appendLine(`[stderr] ${data.toString().substring(0, 200)}`);
        });

        this._process.on('exit', (code, signal) => {
            _log.appendLine(`[CliProcess] Exited: code=${code}, signal=${signal}`);
            this._alive = false;
            this._rejectAllPending(
                new Error(`CLI process exited with code ${code}, signal ${signal}`)
            );
            this._onDidExit.fire({
                code: code ?? null,
                signal: signal ?? null,
            });
        });

        this._process.on('error', (err) => {
            _log.appendLine(`[CliProcess] Error: ${err.message}`);
            this._alive = false;
            this._rejectAllPending(err);
        });
    }

    get isAlive(): boolean {
        return this._alive;
    }

    get sessionId(): string | null {
        return this._sessionId;
    }

    /** Config options advertised by the agent (model, mode, …). */
    get configOptions(): ConfigOption[] {
        return this._configOptions;
    }

    /** Commands the agent advertised; send them as `/name args` prompts. */
    get availableCommands(): AvailableCommand[] {
        return this._availableCommands;
    }

    /** True when `initialize` advertised the Kiro extension method (e.g. `_kiro/session/compact`). */
    hasExtensionMethod(method: string): boolean {
        return this._extensionMethods.includes(method);
    }

    /** Fired when the agent changes the model/mode on its own, with the updated options. */
    set onConfigOptionsChanged(handler: ((options: ConfigOption[], message?: string) => void) | null) {
        this._onConfigOptionsChanged = handler;
    }

    /** Fired for V3 `session_info_update` context-usage updates (also between turns). */
    set onContextUsage(handler: ((usage: ContextUsage) => void) | null) {
        this._onContextUsage = handler;
    }

    /**
     * Asks the user about a tool call. Without a handler, requests are denied
     * once — tools are never approved without the user.
     */
    set onPermissionRequest(handler: ((request: PermissionRequest) => Promise<PermissionDecision>) | null) {
        this._onPermissionRequest = handler;
    }

    /**
     * Performs the ACP initialization handshake and creates a new session.
     */
    async initializeAndCreateSession(workspacePath: string): Promise<string> {
        _log.appendLine(`[ACP] Starting initialize + session/new for ${workspacePath}`);
        const initResponse = await this._sendRaw({
            jsonrpc: '2.0',
            id: this._nextId(),
            method: 'initialize',
            params: {
                protocolVersion: 1,
                // We don't serve files or terminals; kiro-cli uses its own tools
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
                clientInfo: { name: 'kiro-cli-companion', title: 'Kiro CLI Companion', version: '0' },
            },
        });

        if (initResponse.error) {
            throw new Error(`ACP initialize failed: ${initResponse.error.message}`);
        }
        const caps = (initResponse.result as Record<string, unknown> | undefined)?.agentCapabilities as Record<string, unknown> | undefined;
        const kiro = (caps?._meta as { kiro?: { extensionMethods?: unknown } } | undefined)?.kiro;
        this._extensionMethods = Array.isArray(kiro?.extensionMethods)
            ? kiro!.extensionMethods.filter((m): m is string => typeof m === 'string')
            : [];
        _log.appendLine(`[ACP] Initialize OK (${this._extensionMethods.length} extension methods)`);
        return this.createSession(workspacePath);
    }

    /**
     * Creates a fresh ACP session on the already-initialized process
     * (used for "Clear chat" so the mode and history are reset).
     */
    async createSession(workspacePath: string = this.cwd): Promise<string> {
        const sessionResponse = await this._sendRaw({
            jsonrpc: '2.0',
            id: this._nextId(),
            method: 'session/new',
            params: {
                cwd: workspacePath,
                mcpServers: [],
            },
        });

        if (sessionResponse.error) {
            throw new Error(`ACP session/new failed: ${sessionResponse.error.message}`);
        }

        const result = sessionResponse.result as Record<string, unknown> | undefined;
        const sessionId = (result?.sessionId as string) || null;
        if (!sessionId) {
            throw new Error('ACP session/new did not return a sessionId');
        }
        if (this._sessionId && this._sessionId !== sessionId) {
            this._retiredSessions.add(this._sessionId);
        }
        this._sessionId = sessionId;
        _log.appendLine(`[ACP] Session created: ${this._sessionId}`);

        // V3 advertises model and mode as configOptions; fall back to `modes`
        // when an option is missing.
        const options = this._parseConfigOptions(result);
        if (!options.some((o) => o.id === MODE_CONFIG_ID)) {
            options.push(...this._parseModes(result));
        }
        this._configOptions = options;
        return this._sessionId;
    }

    /**
     * Changes an advertised option (model, mode, effortLevel, …) with
     * `session/set_config_option`. CLI V3 has no `session/set_model`.
     */
    async setConfigOption(configId: string, value: string): Promise<ConfigOption[]> {
        if (!this._sessionId) {
            throw new Error('No active session. Call initializeAndCreateSession first.');
        }
        const result = await this.request('session/set_config_option', {
            sessionId: this._sessionId,
            configId,
            value,
        });
        const updated = this._parseConfigOptions(result as Record<string, unknown> | undefined);
        if (updated.length > 0) {
            this._configOptions = updated;
        } else {
            this._setCurrentValue(configId, value);
        }
        return this._configOptions;
    }

    /**
     * Sends a request and returns its result. Rejects with the agent's error.
     * Use `hasExtensionMethod` before calling optional `_kiro/*` methods.
     */
    async request(method: string, params: Record<string, unknown>): Promise<unknown> {
        const response = await this._sendRaw({ jsonrpc: '2.0', id: this._nextId(), method, params });
        return response.result;
    }

    /** Converts the `modes` session result into a config option. */
    private _parseModes(result: Record<string, unknown> | undefined): ConfigOption[] {
        const modes = result?.modes as { currentModeId?: string; availableModes?: Array<Record<string, unknown>> } | undefined;
        if (!modes?.availableModes?.length) {
            return [];
        }
        return [{
            id: MODE_CONFIG_ID,
            name: 'Mode',
            description: 'Agent mode used for this session',
            category: 'mode',
            currentValue: modes.currentModeId || '',
            options: modes.availableModes.map((m) => ({
                value: String(m.id ?? ''),
                name: String(m.name ?? m.id ?? ''),
                description: String(m.description ?? ''),
            })),
        }];
    }

    /** Updates the current value of a config option; adds unknown values (e.g. custom agents). */
    private _setCurrentValue(configId: string, value: string): boolean {
        const option = this._configOptions.find((o) => o.id === configId);
        if (!option || !value || option.currentValue === value) {
            return false;
        }
        option.currentValue = value;
        if (!option.options.some((o) => o.value === value)) {
            option.options.push({ value, name: value, description: '' });
        }
        return true;
    }

    /**
     * Parses configOptions from an ACP result or update object.
     */
    private _parseConfigOptions(result: Record<string, unknown> | undefined): ConfigOption[] {
        if (!Array.isArray(result?.configOptions)) {
            return [];
        }
        try {
            const arr = result.configOptions as Array<Record<string, unknown>>;
            return arr.map((o) => {
                const options = (o.options as Array<Record<string, unknown>> || []).map((opt) => ({
                    value: (opt.value as string) || '',
                    name: (opt.name as string) || (opt.value as string) || '',
                    description: (opt.description as string) || '',
                }));
                return {
                    id: (o.id as string) || '',
                    name: (o.name as string) || (o.id as string) || '',
                    description: (o.description as string) || '',
                    category: (o.category as string) || '',
                    currentValue: (o.currentValue as string) || '',
                    options,
                };
            });
        } catch {
            _log.appendLine('[ACP] Failed to parse configOptions');
            return [];
        }
    }

    /**
     * Sends a prompt to the current session and streams back updates.
     * Calls onUpdate for each session/update notification of this session.
     * Resolves when the `session/prompt` request returns (its stopReason) —
     * not on a turn_end update, which V3 can send before it's done.
     */
    async sendPrompt(
        text: string,
        onUpdate: (update: Record<string, unknown>) => void
    ): Promise<Record<string, unknown>> {
        if (!this._sessionId) {
            throw new Error('No active session. Call initializeAndCreateSession first.');
        }

        _log.appendLine(`[ACP] sendPrompt (${text.length} chars)`);

        return new Promise<Record<string, unknown>>((resolve, reject) => {
            if (!this._alive) {
                reject(new Error('CLI process is not alive'));
                return;
            }

            this._onSessionUpdate = onUpdate;

            const id = this._nextId();
            this._pendingRequests.set(id, {
                resolve: (resp) => {
                    this._onSessionUpdate = null;
                    const r = (resp.result ?? {}) as Record<string, unknown>;
                    resolve(r);
                },
                reject: (err) => {
                    this._onSessionUpdate = null;
                    reject(err);
                },
            });

            this._writeToStdin({
                jsonrpc: '2.0',
                id,
                method: 'session/prompt',
                params: {
                    sessionId: this._sessionId,
                    prompt: [
                        { type: 'text', text },
                    ],
                },
            });
        });
    }

    /**
     * Asks the agent to stop the running turn (`session/cancel` notification).
     * The agent then ends the pending `session/prompt` with stopReason
     * "cancelled". The caller must cancel any open permission requests.
     */
    cancel(): void {
        if (!this._alive || !this._sessionId) {
            return;
        }
        this._writeToStdin({
            jsonrpc: '2.0',
            method: 'session/cancel',
            params: { sessionId: this._sessionId },
        });
    }

    kill(): void {
        if (this._alive) {
            // Close stdin first: ACP agents exit on EOF. This also stops the real
            // CLI when it was started through a shell/.cmd shim, where SIGTERM
            // only reaches the shell and would otherwise leave the CLI running.
            this._process.stdin?.end();
            this._process.kill('SIGTERM');
        }
    }

    dispose(): void {
        this.kill();
        this._onDidExit.dispose();
        this._rejectAllPending(new Error('CliProcess disposed'));
    }

    private _nextId(): string {
        return `${++this._requestCounter}`;
    }

    private _sendRaw(message: Record<string, unknown>): Promise<AcpResponse> {
        return new Promise<AcpResponse>((resolve, reject) => {
            if (!this._alive) {
                reject(new Error('CLI process is not alive'));
                return;
            }
            const id = message.id as string;
            this._pendingRequests.set(id, { resolve, reject });
            this._writeToStdin(message);
        });
    }

    private _writeToStdin(message: Record<string, unknown>): void {
        const json = JSON.stringify(message) + '\n';
        // Log the method only — params can contain prompts and file contents
        _log.appendLine(`[stdin] ${message.method ?? 'response'} id=${message.id}`);
        const stdin = this._process.stdin;
        const failPending = (err: Error) => {
            const pending = this._pendingRequests.get(String(message.id));
            if (message.method && pending) {
                this._pendingRequests.delete(String(message.id));
                pending.reject(err);
            }
        };
        if (!stdin || !stdin.writable) {
            failPending(new Error('CLI process stdin is not writable'));
            return;
        }
        stdin.write(json, (err) => {
            if (err) {
                failPending(err);
            }
        });
    }

    private _handleStdoutData(data: string): void {
        this._stdoutBuffer += data;
        const lines = this._stdoutBuffer.split('\n');
        this._stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            this._processLine(trimmed);
        }
    }

    /** True for updates of a session that "Clear chat" replaced. */
    private _isRetired(params: Record<string, unknown> | undefined): boolean {
        const sessionId = params?.sessionId;
        return typeof sessionId === 'string' && this._retiredSessions.has(sessionId);
    }

    private _processLine(line: string): void {
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
            _log.appendLine(`[parse] Failed to parse JSON: ${line.substring(0, 100)}`);
            return;
        }

        const method = typeof parsed.method === 'string' ? parsed.method : undefined;
        // IDs may be numbers, and 0 is valid (V3's first permission request uses id 0)
        const rawId = parsed.id as string | number | null | undefined;
        const hasId = rawId !== undefined && rawId !== null;
        const params = parsed.params as Record<string, unknown> | undefined;

        // Requests FROM the agent (id + method) always get a response
        if (hasId && method) {
            _log.appendLine(`[ACP] incoming request: ${method} id=${rawId}`);
            void this._handleIncomingRequest(rawId, method, params);
            return;
        }

        // Notifications (method, no id)
        if (method) {
            if (method === 'session/update') {
                if (!this._isRetired(params)) {
                    this._handleSessionUpdate(params?.update as Record<string, unknown> | undefined);
                }
            } else {
                _log.appendLine(`[ACP] notification: ${method}`);
            }
            return;
        }

        // Responses to our requests (id, no method)
        if (hasId) {
            const id = String(rawId);
            const pending = this._pendingRequests.get(id);
            if (!pending) {
                _log.appendLine(`[ACP] response id=${id} but no pending request`);
                return;
            }

            this._pendingRequests.delete(id);
            _log.appendLine(`[ACP] response id=${id}, hasError=${!!parsed.error}`);

            if (parsed.error) {
                const err = parsed.error as { message?: string; code?: number; data?: unknown };
                // kiro-cli puts the useful explanation in `data`, either as a
                // string or as { details: "…" }
                const data = err.data as string | { details?: unknown } | undefined;
                const detailText = typeof data === 'string' ? data : typeof data?.details === 'string' ? data.details : '';
                const detail = detailText.trim() ? `: ${detailText.trim()}` : '';
                const error = new Error((err.message || 'ACP error') + detail) as Error & { code?: number };
                error.code = err.code;
                pending.reject(error);
            } else {
                pending.resolve(parsed as unknown as AcpResponse);
            }
            return;
        }

        _log.appendLine(`[ACP] unhandled message: ${line.substring(0, 100)}`);
    }

    /** Tracks session-level state from updates, then forwards them to the running prompt. */
    private _handleSessionUpdate(update: Record<string, unknown> | undefined): void {
        if (!update) {
            return;
        }
        switch (update.sessionUpdate) {
            case 'current_mode_update':
                if (typeof update.currentModeId === 'string' && this._setCurrentValue(MODE_CONFIG_ID, update.currentModeId)) {
                    this._onConfigOptionsChanged?.(this._configOptions, `Switched to mode "${update.currentModeId}"`);
                }
                break;
            case 'config_option_update': {
                // A full snapshot of the advertised options
                const options = this._parseConfigOptions(update);
                if (options.length) {
                    const before = this._configOptions.find((o) => o.id === MODE_CONFIG_ID)?.currentValue;
                    this._configOptions = options;
                    const after = options.find((o) => o.id === MODE_CONFIG_ID)?.currentValue;
                    this._onConfigOptionsChanged?.(
                        this._configOptions,
                        before && after && before !== after ? `Switched to mode "${after}"` : undefined
                    );
                }
                break;
            }
            case 'available_commands_update':
                if (Array.isArray(update.availableCommands)) {
                    this._availableCommands = (update.availableCommands as Array<Record<string, unknown>>)
                        .filter((c) => typeof c.name === 'string')
                        .map((c) => ({
                            name: c.name as string,
                            description: typeof c.description === 'string' ? c.description : '',
                            hint: (c.input as { hint?: string } | undefined)?.hint,
                        }));
                }
                break;
            case 'session_info_update': {
                const kiro = (update._meta as { kiro?: Record<string, unknown> } | undefined)?.kiro;
                if (kiro?.kind === 'context_usage') {
                    const usage = parseContextUsage(kiro);
                    if (usage) {
                        this._onContextUsage?.(usage);
                    }
                }
                break;
            }
        }
        this._onSessionUpdate?.(update);
    }

    /**
     * Answers JSON-RPC requests from the agent. Unknown methods get an error
     * so the agent never waits forever.
     */
    private async _handleIncomingRequest(
        id: string | number,
        method: string,
        params: Record<string, unknown> | undefined
    ): Promise<void> {
        if (method === 'session/request_permission') {
            const request = this._parsePermissionRequest(params);
            let decision: PermissionDecision;
            if (this._isRetired(params)) {
                decision = { cancelled: true };
            } else if (this._onPermissionRequest) {
                try {
                    decision = await this._onPermissionRequest(request);
                } catch (err) {
                    _log.appendLine(`[ACP] Permission handler failed: ${err}`);
                    decision = { cancelled: true };
                }
            } else {
                const reject = request.options.find((o) => o.kind === 'reject_once');
                decision = reject ? { optionId: reject.optionId } : { cancelled: true };
            }
            const result = buildPermissionResult(request, decision);
            const outcome = result.outcome as { outcome: string; optionId?: string };
            _log.appendLine(`[ACP] Permission for ${request.consent?.capability ?? 'tool'}: ${outcome.optionId ?? outcome.outcome}`);
            this._writeToStdin({ jsonrpc: '2.0', id, result });
            return;
        }

        _log.appendLine(`[ACP] Unsupported incoming request: ${method}, responding with error`);
        this._writeToStdin({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not supported: ${method}` },
        });
    }

    private _parsePermissionRequest(params: Record<string, unknown> | undefined): PermissionRequest {
        const toolCall = (params?.toolCall ?? {}) as Record<string, unknown>;
        const options = Array.isArray(params?.options)
            ? (params!.options as Array<Record<string, unknown>>)
                .filter((o) => typeof o.optionId === 'string')
                .map((o) => ({
                    optionId: o.optionId as string,
                    name: typeof o.name === 'string' ? o.name : (o.optionId as string),
                    kind: typeof o.kind === 'string' ? o.kind : '',
                }))
            : [];
        const consent = ((params?._meta as { kiro?: { consent?: ConsentContext } } | undefined)?.kiro?.consent);
        return {
            sessionId: typeof params?.sessionId === 'string' ? params.sessionId : '',
            toolCallId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined,
            title: typeof toolCall.title === 'string' ? toolCall.title : 'Tool call',
            options,
            consent: consent && typeof consent === 'object' ? consent : undefined,
        };
    }

    private _rejectAllPending(error: Error): void {
        for (const [, pending] of this._pendingRequests) {
            pending.reject(error);
        }
        this._pendingRequests.clear();
    }
}
