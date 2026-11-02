/**
 * Slash commands for the CLI V3 engine. V3 has no generic "execute command"
 * API, so each command is routed by the client: some change advertised
 * session options, some call Kiro extension methods, some are local. Commands
 * the agent advertises (available_commands_update) are sent as prompts.
 * See https://kiro.dev/docs/cli/v3/acp-migration/#6-replace-command-apis
 */

export type SlashAction =
    | { kind: 'clear' }
    | { kind: 'help' }
    /** `value` missing → list the choices. `then` is sent as a prompt afterwards (/plan <text>). */
    | { kind: 'setOption'; configId: string; label: string; value?: string; then?: string }
    | { kind: 'context' }
    | { kind: 'compact' }
    | { kind: 'permissions' }
    /** A command the agent advertised; send the text as-is. */
    | { kind: 'agentCommand'; text: string }
    | { kind: 'unknown'; name: string };

/** Commands handled by the extension, for /help. */
export const BUILTIN_COMMANDS: Array<{ usage: string; description: string }> = [
    { usage: '/model [name]', description: 'Show or change the model' },
    { usage: '/agent [name]', description: 'Show or change the agent mode (also /mode)' },
    { usage: '/plan [text]', description: 'Switch to the Plan mode, optionally with a request' },
    { usage: '/effort [level]', description: 'Show or change the reasoning effort, when the model supports it' },
    { usage: '/context', description: 'Show context window usage' },
    { usage: '/compact', description: 'Summarize the conversation to free context' },
    { usage: '/permissions', description: 'Open the permissions file (also /tools)' },
    { usage: '/clear', description: 'Start a new conversation' },
    { usage: '/help', description: 'Show this list' },
];

/** Parses `/name args`. Returns null when the text isn't a slash command. */
export function parseSlashCommand(text: string, advertised: readonly string[]): SlashAction | null {
    const trimmed = text.trim();
    const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (!match) {
        return null;
    }
    const name = match[1];
    const args = (match[2] ?? '').trim();
    // Advertised commands come first: the agent defined them
    if (advertised.includes(name)) {
        return { kind: 'agentCommand', text: trimmed };
    }
    switch (name.toLowerCase()) {
        case 'clear':
            return { kind: 'clear' };
        case 'help':
            return { kind: 'help' };
        case 'model':
            return { kind: 'setOption', configId: 'model', label: 'Model', value: args || undefined };
        case 'agent':
        case 'mode':
            return { kind: 'setOption', configId: 'mode', label: 'Mode', value: args || undefined };
        case 'plan':
            return { kind: 'setOption', configId: 'mode', label: 'Mode', value: 'plan', then: args || undefined };
        case 'effort':
            return { kind: 'setOption', configId: 'effortLevel', label: 'Effort', value: args || undefined };
        case 'context':
            return { kind: 'context' };
        case 'compact':
            return { kind: 'compact' };
        case 'permissions':
        case 'tools':
            return { kind: 'permissions' };
        default:
            return { kind: 'unknown', name };
    }
}
