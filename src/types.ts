/**
 * Shared types: the ACP (JSON-RPC) response shape, CLI state, and the
 * message protocol between the extension host and the chat webview.
 */

import type { CliProcess } from './cli/cliProcess';

// ---------------------------------------------------------------------------
// ACP (JSON-RPC 2.0 over stdin/stdout)
// ---------------------------------------------------------------------------

export interface AcpError {
    code: number;
    message: string;
    /** kiro-cli often puts the human-readable explanation here. */
    data?: unknown;
}

/** A JSON-RPC response from kiro-cli. `result` depends on the method. */
export interface AcpResponse {
    jsonrpc: '2.0';
    id: string;
    result?: unknown;
    error?: AcpError;
}

// ---------------------------------------------------------------------------
// Context usage (header ring)
// ---------------------------------------------------------------------------

export interface ContextUsage {
    conversation: number;
    mcpTools: number;
    steeringFiles: number;
    total: number;
}

// ---------------------------------------------------------------------------
// Spec workflow
// ---------------------------------------------------------------------------

export type SpecPhase = 'requirements' | 'design' | 'tasks';

// ---------------------------------------------------------------------------
// CLI state
// ---------------------------------------------------------------------------

export type CliState =
    | { status: 'not_found' }
    | { status: 'not_authenticated' }
    | { status: 'ready'; cliPath: string }
    | { status: 'running'; cliPath: string; process: CliProcess; cwd: string };

// ---------------------------------------------------------------------------
// Webview message protocol
// ---------------------------------------------------------------------------

/** Extension Host → Webview */
export type ExtToWebviewMessage =
    | { type: 'response'; content: string; done: boolean }
    /** `toolCallId` lets the webview update one line per tool call instead of adding a new one. */
    | { type: 'toolStatus'; title: string; status: string; kind: string; toolCallId?: string }
    | { type: 'error'; message: string }
    | { type: 'loading'; active: boolean }
    | { type: 'systemMessage'; message: string }
    | { type: 'configOptions'; options: ConfigOption[] }
    | { type: 'clearChat' }
    | { type: 'contextUsage'; usage: ContextUsage }
    | { type: 'sessionInfo'; info: SessionInfo }
    | { type: 'specPhaseBar'; phase: SpecPhase; phaseIndex: number; phases: string[] }
    /** The message is waiting for the current turn to finish. */
    | { type: 'messageQueued'; id: string }
    /** A queued message is now being sent to kiro-cli. */
    | { type: 'messageDequeued'; id: string }
    /** A queued message was discarded (chat cleared or an earlier message failed). */
    | { type: 'messageDropped'; id: string }
    /** kiro-cli asks before running a tool; the webview shows the agent's options. */
    | { type: 'permissionRequest'; request: PermissionPrompt }
    /** The request was answered (or cancelled) and its card should be closed. */
    | { type: 'permissionResolved'; requestId: string; label: string };

// ---------------------------------------------------------------------------
// Tool permissions (CLI V3 session/request_permission)
// ---------------------------------------------------------------------------

/** ACP permission option kinds. */
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

/** One choice offered by the agent. Only these may be returned. */
export interface PermissionOption {
    optionId: string;
    name: string;
    kind: PermissionOptionKind | string;
}

/** Where an "always" choice is saved. */
export type ConsentScope = 'session' | 'workspace' | 'user';

/** What the webview needs to render a permission card. */
export interface PermissionPrompt {
    requestId: string;
    /** Tool call title, e.g. the shell command. Display only. */
    title: string;
    /** Capability being requested, e.g. "shell", "fs_write". */
    capability?: string;
    /** The resource the rule would cover, e.g. "npm run test". */
    resource?: string;
    options: PermissionOption[];
    /** Scopes the user can save an "always" choice to. */
    scopes: ConsentScope[];
}

/**
 * Describes where/how kiro-cli is (or will be) running, shown in the chat header.
 */
export interface SessionInfo {
    /** Directory kiro-cli runs in (process cwd and ACP session cwd). */
    cwd: string;
    /** How the cwd was chosen, e.g. "setting", "workspace folder". */
    cwdSource: string;
    /** Resolved path of the kiro-cli binary, if found. */
    cliPath: string | null;
    /** How the binary was found, e.g. "PATH", "kiro.cliPath setting". */
    cliSource: string | null;
    /** True when a kiro-cli process is alive with an ACP session. */
    running: boolean;
    /** ACP session ID when running. */
    sessionId: string | null;
    /** True for multi-root workspaces, where changing the directory is most relevant. */
    multiRoot: boolean;
    /** True once the conversation has started; the directory can't change until the chat is cleared. */
    locked?: boolean;
}

/** Webview → Extension Host */
export type WebviewToExtMessage =
    /** `id` lets the webview track the bubble while the message is queued. */
    | { type: 'sendMessage'; text: string; id?: string }
    | { type: 'retry' }
    /** Stop button: cancel the running turn and drop queued messages. */
    | { type: 'stop' }
    | { type: 'selectModel'; configId: string; value: string }
    | { type: 'specAccept' }
    | { type: 'specSave' }
    | { type: 'specCancel' }
    | { type: 'startSpec' }
    | { type: 'clearChat' }
    | { type: 'ready' }
    | { type: 'changeWorkingDirectory' }
    /** The user's answer to a permission card. `scope` applies to "always" options. */
    | { type: 'permissionResponse'; requestId: string; optionId: string; scope?: ConsentScope };

// ---------------------------------------------------------------------------
// Session config options (model / agent selectors)
// ---------------------------------------------------------------------------

export interface ConfigOption {
    id: string;
    name: string;
    description: string;
    category: string;
    currentValue: string;
    options: ConfigOptionValue[];
}

export interface ConfigOptionValue {
    value: string;
    name: string;
    description: string;
}
