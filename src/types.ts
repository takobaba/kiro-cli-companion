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
    | { type: 'toolStatus'; title: string; status: string; kind: string }
    | { type: 'error'; message: string }
    | { type: 'loading'; active: boolean }
    | { type: 'systemMessage'; message: string }
    | { type: 'configOptions'; options: ConfigOption[] }
    | { type: 'clearChat' }
    | { type: 'contextUsage'; usage: ContextUsage }
    | { type: 'sessionInfo'; info: SessionInfo }
    | { type: 'specPhaseBar'; phase: SpecPhase; phaseIndex: number; phases: string[] };

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
}

/** Webview → Extension Host */
export type WebviewToExtMessage =
    | { type: 'sendMessage'; text: string }
    | { type: 'retry' }
    | { type: 'selectModel'; configId: string; value: string }
    | { type: 'specAccept' }
    | { type: 'specSave' }
    | { type: 'specCancel' }
    | { type: 'startSpec' }
    | { type: 'clearChat' }
    | { type: 'ready' }
    | { type: 'changeWorkingDirectory' };

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
