#!/usr/bin/env node
/**
 * Minimal stand-in for `kiro-cli acp` used by the tests. Speaks just enough
 * ACP (newline-delimited JSON-RPC over stdin/stdout) for the extension:
 *   initialize → session/new → session/prompt (echoes the prompt back)
 * Exits when stdin closes, like a well-behaved agent.
 */
'use strict';

if (process.argv[2] !== 'acp') {
    process.stderr.write('fake-kiro-cli: only "acp" is supported\n');
    process.exit(1);
}

let buffer = '';
let sessions = 0;
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            continue;
        }
        if (!msg.method || msg.id === undefined) {
            continue; // responses to our own requests (none) / notifications
        }
        switch (msg.method) {
            case 'initialize':
                send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
                break;
            case 'session/new':
                send({
                    id: msg.id,
                    result: {
                        sessionId: `fake-session-${++sessions}`,
                        models: { currentModelId: 'auto', availableModels: [{ modelId: 'auto', name: 'auto' }] },
                        modes: { currentModeId: 'kiro_default', availableModes: [{ id: 'kiro_default', name: 'kiro_default' }] },
                    },
                });
                break;
            case 'session/prompt': {
                const text = (msg.params?.prompt ?? []).map((p) => p.text ?? '').join('');
                send({
                    method: 'session/update',
                    params: {
                        sessionId: msg.params?.sessionId,
                        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}` } },
                    },
                });
                send({ id: msg.id, result: { stopReason: 'end_turn' } });
                break;
            }
            default:
                send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        }
    }
});
process.stdin.on('end', () => process.exit(0));
