/**
 * CliProcess wraps a single Kiro CLI child process, handling ACP message
 * framing over stdin/stdout using newline-delimited JSON.
 *
 * Implements the ACP protocol lifecycle:
 *   initialize → session/new → session/prompt → session/update notifications
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import type { AcpRequest, AcpResponse, ConfigOption } from '../types';
import { cliSpawnTarget } from './cliLocator';

/** Shared output channel for ACP protocol debugging */
const _log = vscode.window.createOutputChannel('Kiro ACP');

/** Synthetic config option IDs for kiro-cli's `models` / `modes` session data. */
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

export class CliProcess implements vscode.Disposable {
    private readonly _process: ChildProcess;
    private _alive: boolean = false;
    private readonly _pendingRequests = new Map<string, PendingRequest>();
    private _stdoutBuffer: string = '';
    private _sessionId: string | null = null;
    private _onSessionUpdate: ((update: Record<string, unknown>) => void) | null = null;
    private _onMetadata: ((metadata: Record<string, unknown>) => void) | null = null;
    private _onConfigOptionsChanged: ((options: ConfigOption[], message?: string) => void) | null = null;
    private _requestCounter = 0;
    private _configOptions: ConfigOption[] = [];

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
        _log.appendLine(`[CliProcess] Spawning: ${cliPath} acp (cwd: ${workspacePath}${target.shell ? ', via shell' : ''})`);
        this._process = spawn(target.command, ['acp'], {
            cwd: workspacePath,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: target.shell,
            windowsHide: true,
            env: env ?? process.env,
        });
        this._alive = true;

        this._process.stdout?.on('data', (data: Buffer) => {
            const str = data.toString();
            _log.appendLine(`[stdout] ${str.length} bytes: ${str.substring(0, 200)}`);
            this._handleStdoutData(str);
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

    /** Config options received from the agent (e.g., model selector). */
    get configOptions(): ConfigOption[] {
        return this._configOptions;
    }

    /**
     * Sets a callback for `_kiro.dev/metadata` notifications.
     * Used to receive context usage percentage and other metadata.
     */
    set onMetadata(handler: ((metadata: Record<string, unknown>) => void) | null) {
        this._onMetadata = handler;
    }

    /**
     * Sets a callback fired when the CLI changes the model/agent on its own
     * (e.g. `/plan`, `/agent swap`, `/model`), with the updated options.
     */
    set onConfigOptionsChanged(handler: ((options: ConfigOption[], message?: string) => void) | null) {
        this._onConfigOptionsChanged = handler;
    }

    /**
     * Performs the ACP initialization handshake and creates a new session.
     */
    async initializeAndCreateSession(workspacePath: string): Promise<string> {
        _log.appendLine(`[ACP] Starting initialize + session/new for ${workspacePath}`);
        // Step 1: initialize (ACP protocol version is an integer; kiro-cli speaks v1)
        const initResponse = await this._sendRaw({
            jsonrpc: '2.0',
            id: this._nextId(),
            method: 'initialize',
            params: { protocolVersion: 1, clientCapabilities: {} },
        });

        if (initResponse.error) {
            throw new Error(`ACP initialize failed: ${initResponse.error.message}`);
        }
        _log.appendLine(`[ACP] Initialize OK`);
        return this.createSession(workspacePath);
    }

    /**
     * Creates a fresh ACP session on the already-initialized process
     * (used for "Clear chat" so slash-command state like /plan is reset).
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
        this._sessionId = (result?.sessionId as string) || null;
        if (!this._sessionId) {
            throw new Error('ACP session/new did not return a sessionId');
        }

        _log.appendLine(`[ACP] Session created: ${this._sessionId}`);

        // kiro-cli returns `models` and `modes` (agents); generic agents may
        // return `configOptions`. Normalise all of them into ConfigOptions.
        this._configOptions = [
            ...this._parseModelsAndModes(result),
            ...this._parseConfigOptions(result),
        ];

        return this._sessionId;
    }

    /**
     * Changes a session option. Models and modes (agents) use the ACP
     * `session/set_model` / `session/set_mode` methods; anything else goes
     * through `session/set_config_option`.
     *
     * Requirement 12.2
     */
    async setConfigOption(configId: string, value: string): Promise<ConfigOption[]> {
        if (!this._sessionId) {
            throw new Error('No active session. Call initializeAndCreateSession first.');
        }

        if (configId === MODEL_CONFIG_ID || configId === MODE_CONFIG_ID) {
            const isModel = configId === MODEL_CONFIG_ID;
            const response = await this._sendRaw({
                jsonrpc: '2.0',
                id: this._nextId(),
                method: isModel ? 'session/set_model' : 'session/set_mode',
                params: isModel
                    ? { sessionId: this._sessionId, modelId: value }
                    : { sessionId: this._sessionId, modeId: value },
            });
            if (response.error) {
                throw new Error(`${isModel ? 'set_model' : 'set_mode'} failed: ${(response.error as { message?: string }).message}`);
            }
            this._setCurrentValue(configId, value);
            return this._configOptions;
        }

        const response = await this._sendRaw({
            jsonrpc: '2.0',
            id: this._nextId(),
            method: 'session/set_config_option',
            params: {
                sessionId: this._sessionId,
                configId,
                value,
            },
        });

        if (response.error) {
            throw new Error(`set_config_option failed: ${(response.error as { message?: string }).message}`);
        }

        const result = response.result as Record<string, unknown> | undefined;
        const updated = this._parseConfigOptions(result);
        if (updated.length > 0) {
            this._configOptions = updated;
        }
        return this._configOptions;
    }

    /**
     * Converts kiro-cli's `models` / `modes` session result into ConfigOptions.
     *   models: { currentModelId, availableModels: [{ modelId, name, description }] }
     *   modes:  { currentModeId,  availableModes:  [{ id, name, description }] }
     */
    private _parseModelsAndModes(result: Record<string, unknown> | undefined): ConfigOption[] {
        const out: ConfigOption[] = [];
        try {
            const models = result?.models as { currentModelId?: string; availableModels?: Array<Record<string, unknown>> } | undefined;
            if (models?.availableModels?.length) {
                out.push({
                    id: MODEL_CONFIG_ID,
                    name: 'Model',
                    description: 'Model used for this session',
                    category: 'model',
                    currentValue: models.currentModelId || '',
                    options: models.availableModels.map((m) => ({
                        value: String(m.modelId ?? ''),
                        name: String(m.name ?? m.modelId ?? ''),
                        description: String(m.description ?? ''),
                    })),
                });
            }
            const modes = result?.modes as { currentModeId?: string; availableModes?: Array<Record<string, unknown>> } | undefined;
            if (modes?.availableModes?.length) {
                out.push({
                    id: MODE_CONFIG_ID,
                    name: 'Agent',
                    description: 'Agent (mode) used for this session',
                    category: 'mode',
                    currentValue: modes.currentModeId || '',
                    options: modes.availableModes.map((m) => ({
                        value: String(m.id ?? ''),
                        name: String(m.name ?? m.id ?? ''),
                        description: String(m.description ?? ''),
                    })),
                });
            }
        } catch {
            _log.appendLine('[ACP] Failed to parse models/modes');
        }
        return out;
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
     * Parses configOptions from an ACP response result object.
     */
    private _parseConfigOptions(result: Record<string, unknown> | undefined): ConfigOption[] {
        if (!result?.configOptions) {
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
     * Calls onUpdate for each session/update notification.
     * Resolves when the prompt turn completes (stopReason received).
     */
    async sendPrompt(
        text: string,
        onUpdate: (update: Record<string, unknown>) => void
    ): Promise<Record<string, unknown>> {
        if (!this._sessionId) {
            throw new Error('No active session. Call initializeAndCreateSession first.');
        }

        _log.appendLine(`[ACP] sendPrompt: "${text.substring(0, 80)}..."`);

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
     * Low-level: send a raw ACP request and wait for the matching response.
     */
    sendRequest(request: AcpRequest): Promise<AcpResponse> {
        return this._sendRaw(request as unknown as Record<string, unknown>) as Promise<AcpResponse>;
    }

    kill(): void {
        if (this._alive) {
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
        _log.appendLine(`[stdin] Writing: ${json.substring(0, 150)}`);
        const stdin = this._process.stdin;
        if (!stdin || !stdin.writable) {
            const id = message.id as string;
            const pending = this._pendingRequests.get(id);
            if (pending) {
                this._pendingRequests.delete(id);
                pending.reject(new Error('CLI process stdin is not writable'));
            }
            return;
        }
        stdin.write(json, (err) => {
            if (err) {
                const id = message.id as string;
                const pending = this._pendingRequests.get(id);
                if (pending) {
                    this._pendingRequests.delete(id);
                    pending.reject(err);
                }
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

    private _processLine(line: string): void {
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
            _log.appendLine(`[parse] Failed to parse JSON: ${line.substring(0, 100)}`);
            return;
        }

        const method = parsed.method as string | undefined;
        const id = parsed.id as string | undefined;

        // Handle requests FROM the CLI (has both id and method)
        // e.g. session/request_permission
        if (id && method) {
            _log.appendLine(`[ACP] incoming request: ${method} id=${id}`);
            this._handleIncomingRequest(id, method, parsed.params as Record<string, unknown> | undefined);
            return;
        }

        // Handle notifications (has method but no id) — e.g. session/update
        if (!id && method) {
            if (method === 'session/update') {
                const params = parsed.params as Record<string, unknown> | undefined;
                const update = params?.update as Record<string, unknown> | undefined;
                // Standard ACP mode change notification — track it even between prompts
                if (update?.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
                    if (this._setCurrentValue(MODE_CONFIG_ID, update.currentModeId)) {
                        this._onConfigOptionsChanged?.(this._configOptions, `Switched to agent "${update.currentModeId}"`);
                    }
                }
                if (update && this._onSessionUpdate) {
                    _log.appendLine(`[ACP] session/update: ${update.sessionUpdate}`);
                    this._onSessionUpdate(update);
                } else {
                    _log.appendLine(`[ACP] session/update but no handler or no params.update`);
                }
            } else if (method === '_kiro.dev/metadata') {
                const params = parsed.params as Record<string, unknown> | undefined;
                _log.appendLine(`[ACP] _kiro.dev/metadata notification received`);
                if (params && this._onMetadata) {
                    this._onMetadata(params);
                }
            } else if (method === '_kiro.dev/agent/switched') {
                // Fired after /plan, /agent swap, set_mode, etc.
                const params = parsed.params as Record<string, unknown> | undefined;
                const agent = params?.agentName as string | undefined;
                const model = params?.model as string | undefined;
                _log.appendLine(`[ACP] agent switched to ${agent} (model ${model})`);
                const changedMode = agent ? this._setCurrentValue(MODE_CONFIG_ID, agent) : false;
                const changedModel = model ? this._setCurrentValue(MODEL_CONFIG_ID, model) : false;
                if (changedMode || changedModel) {
                    this._onConfigOptionsChanged?.(
                        this._configOptions,
                        changedMode ? `Switched to agent "${agent}"` : undefined
                    );
                }
            } else {
                _log.appendLine(`[ACP] notification: ${method}`);
            }
            return;
        }

        // Handle responses to our pending requests (has id but no method)
        if (id && !method) {
            const pending = this._pendingRequests.get(id);
            if (!pending) {
                _log.appendLine(`[ACP] response id=${id} but no pending request`);
                return;
            }

            this._pendingRequests.delete(id);
            _log.appendLine(`[ACP] response id=${id}, hasError=${!!parsed.error}`);

            if (parsed.error) {
                const err = parsed.error as { message?: string; code?: number; data?: unknown };
                // kiro-cli puts the useful explanation in `data`, e.g.
                // "Failed to start session: Session is active in another process (PID 1234)"
                const detail = typeof err.data === 'string' && err.data.trim() ? `: ${err.data.trim()}` : '';
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

    /**
     * Handles incoming JSON-RPC requests from the CLI that expect a response.
     * Currently handles session/request_permission by auto-approving.
     */
    private _handleIncomingRequest(
        id: string,
        method: string,
        params: Record<string, unknown> | undefined
    ): void {
        if (method === 'session/request_permission') {
            const options = params?.options as Array<{ optionId: string; kind: string }> | undefined;
            // Auto-approve: pick "allow_once" option
            const allowOption = options?.find(o => o.kind === 'allow_once');
            const optionId = allowOption?.optionId ?? 'allow_once';

            const toolCall = params?.toolCall as Record<string, unknown> | undefined;
            _log.appendLine(`[ACP] Auto-approving permission for: ${toolCall?.title ?? 'unknown'} (optionId=${optionId})`);

            // ACP spec requires outcome wrapper with "selected" discriminator
            this._writeToStdin({
                jsonrpc: '2.0',
                id,
                result: {
                    outcome: {
                        outcome: 'selected',
                        optionId,
                    },
                },
            });
            return;
        }

        if (method === 'session/request_input') {
            // Some CLI versions send input requests — auto-respond with empty
            _log.appendLine(`[ACP] Auto-responding to input request id=${id}`);
            this._writeToStdin({
                jsonrpc: '2.0',
                id,
                result: { input: '' },
            });
            return;
        }

        _log.appendLine(`[ACP] Unknown incoming request method: ${method}, responding with error`);
        this._writeToStdin({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not supported: ${method}` },
        });
    }

    private _rejectAllPending(error: Error): void {
        for (const [, pending] of this._pendingRequests) {
            pending.reject(error);
        }
        this._pendingRequests.clear();
    }
}
