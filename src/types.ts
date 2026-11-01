/**
 * Shared data models and ACP types for the Kiro VS Code Extension.
 *
 * Requirements: 3.2, 4.3, 5.2, 6.1
 */

import type { CliProcess } from './cli/cliProcess';

// ---------------------------------------------------------------------------
// ACP Message Types (Requirement 3.2)
// ---------------------------------------------------------------------------

/** Base ACP message envelope */
export interface AcpMessage {
    jsonrpc: '2.0';
    id: string;
}

/** ACP request sent to CLI */
export interface AcpRequest extends AcpMessage {
    method: string;
    params: {
        message?: string;
        context?: WorkspaceContext;
        specPhase?: SpecPhase;
        specOutput?: string;
    };
}

/** ACP response from CLI */
export interface AcpResponse extends AcpMessage {
    result?: {
        content: string;
        artifacts?: SpecArtifact[];
    };
    error?: AcpError;
}

/** ACP streaming chunk */
export interface AcpStreamChunk {
    id: string;
    delta: string;
    done: boolean;
}

export interface AcpError {
    code: number;
    message: string;
    data?: unknown;
}

// ---------------------------------------------------------------------------
// Context Usage Types
// ---------------------------------------------------------------------------

export interface ContextUsage {
    conversation: number;
    mcpTools: number;
    steeringFiles: number;
    total: number;
}

// ---------------------------------------------------------------------------
// Spec Types (Requirement 5.2)
// ---------------------------------------------------------------------------

export type SpecPhase = 'requirements' | 'design' | 'tasks';

export interface SpecArtifact {
    phase: SpecPhase;
    fileName: string;
    content: string;
}

// ---------------------------------------------------------------------------
// CLI State Types (Requirement 3.2)
// ---------------------------------------------------------------------------

/**
 * Represents the current state of the CLI process.
 */
export type CliState =
    | { status: 'not_found' }
    | { status: 'not_authenticated' }
    | { status: 'ready'; cliPath: string }
    | { status: 'running'; cliPath: string; process: CliProcess; cwd: string }
    | { status: 'error'; message: string };

export type ExtensionStatus = 'active' | 'inactive' | 'error';

// ---------------------------------------------------------------------------
// Workspace Context Types (Requirement 6.1)
// ---------------------------------------------------------------------------

export interface WorkspaceContext {
    activeFile: FileContext | null;
    selectedFiles: FileContext[];
    steeringFiles: FileContext[];
}

export interface FileContext {
    path: string;
    content: string;
    languageId?: string;
}

// ---------------------------------------------------------------------------
// Webview Message Protocol (Requirement 4.3)
// ---------------------------------------------------------------------------

/** Extension Host → Webview */
export type ExtToWebviewMessage =
    | { type: 'response'; content: string; done: boolean }
    | { type: 'toolStatus'; title: string; status: string; kind: string }
    | { type: 'error'; message: string }
    | { type: 'loading'; active: boolean }
    | { type: 'specPhase'; phase: SpecPhase; phaseIndex: number }
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
    | { type: 'selectFiles'; paths: string[] }
    | { type: 'advanceSpec'; phaseOutput: string }
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
// Config Option Types (Requirement 12)
// ---------------------------------------------------------------------------

/** A session-level configuration option (e.g., model selector). */
export interface ConfigOption {
    id: string;
    name: string;
    description: string;
    category: string;
    currentValue: string;
    options: ConfigOptionValue[];
}

/** A selectable value within a config option. */
export interface ConfigOptionValue {
    value: string;
    name: string;
    description: string;
}
