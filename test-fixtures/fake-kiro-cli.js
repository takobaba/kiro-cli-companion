#!/usr/bin/env node
/**
 * Stand-in for `kiro-cli acp --agent-engine=v3` used by the tests. Mirrors
 * the real CLI V3 ACP server closely enough for the extension (shapes were
 * recorded from kiro-cli 2.37.1):
 *   - refuses to start without --agent-engine=v3
 *   - session/new returns `modes` and `configOptions` (model + mode)
 *   - session/set_config_option works; session/set_model is not implemented
 *   - session/prompt echoes the prompt, after a context_usage update
 *   - a prompt containing "RUN:<command>" first asks for permission
 *     (agent → client request with id 0, like V3), then reports the outcome
 * Exits when stdin closes, like a well-behaved agent.
 */
'use strict';

if (process.argv[2] !== 'acp' || !process.argv.includes('--agent-engine=v3')) {
    process.stderr.write(`fake-kiro-cli: expected "acp --agent-engine=v3", got: ${process.argv.slice(2).join(' ')}\n`);
    process.exit(2);
}

let buffer = '';
let sessions = 0;
/** Our own requests to the client, by id: resolve(response) */
const waiting = new Map();
let nextAgentRequestId = 0;
let model = 'auto';
let mode = 'vibe';

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

const configOptions = () => [
    {
        type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: mode,
        options: [
            { value: 'vibe', name: 'Default', description: 'General coding assistance' },
            { value: 'plan', name: 'Plan', description: 'Plan-only mode' },
        ],
    },
    {
        type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: model,
        options: [
            { value: 'auto', name: 'Auto', description: '' },
            { value: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', description: '' },
        ],
    },
];

/** Sends a request to the client and resolves with its response. */
function ask(method, params) {
    const id = nextAgentRequestId++;
    send({ id, method, params });
    return new Promise((resolve) => waiting.set(id, resolve));
}

async function handlePrompt(msg) {
    const sessionId = msg.params?.sessionId;
    const text = (msg.params?.prompt ?? []).map((p) => p.text ?? '').join('');
    update(sessionId, {
        sessionUpdate: 'session_info_update',
        _meta: { kiro: { kind: 'context_usage', usagePercentage: 12.5, breakdown: { yourPrompts: { percent: 2 }, kiroResponses: { percent: 3 }, contextFiles: { percent: 4 }, tools: { percent: 3.5, mcp: { percent: 1 } } } } },
    });

    const run = /RUN:(.+)$/m.exec(text);
    if (run) {
        const command = run[1].trim();
        const toolCallId = `call-${Date.now()}`;
        update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: command, kind: 'execute', status: 'pending' });
        const response = await ask('session/request_permission', {
            sessionId,
            toolCall: { toolCallId, status: 'pending', title: command },
            options: [
                { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
                { optionId: 'always-accept', name: 'Always allow', kind: 'allow_always' },
                { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
                { optionId: 'always-reject', name: 'Always deny', kind: 'reject_always' },
            ],
            _meta: { kiro: { toolId: 'run_command', consent: { capability: 'shell', resource: command, askType: 'implicit', triggeringResource: command, workspaceRoot: process.cwd() } } },
        });
        const outcome = response.result?.outcome;
        const consent = response.result?._meta?.kiro?.consent;
        const allowed = outcome?.outcome === 'selected' && /accept/.test(outcome.optionId);
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed' });
        update(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `permission: ${outcome?.optionId ?? outcome?.outcome}${consent ? ` scope=${consent.scope} resource=${consent.resource}` : ''}` },
        });
        send({ id: msg.id, result: { stopReason: 'end_turn' } });
        return;
    }

    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}` } });
    send({ id: msg.id, result: { stopReason: 'end_turn' } });
}

function handle(msg) {
    // Responses to our requests (permission answers)
    if (!msg.method && msg.id !== undefined) {
        const resolve = waiting.get(msg.id);
        if (resolve) {
            waiting.delete(msg.id);
            resolve(msg);
        }
        return;
    }
    if (!msg.method || msg.id === undefined) {
        return; // notifications
    }
    switch (msg.method) {
        case 'initialize':
            send({
                id: msg.id,
                result: {
                    protocolVersion: 1,
                    agentCapabilities: { loadSession: true, _meta: { kiro: { extensionMethods: ['_kiro/session/compact'] } } },
                },
            });
            break;
        case 'session/new': {
            const sessionId = `fake-session-${++sessions}`;
            mode = 'vibe';
            send({
                id: msg.id,
                result: {
                    sessionId,
                    modes: { currentModeId: mode, availableModes: [{ id: 'vibe', name: 'Default' }, { id: 'plan', name: 'Plan' }] },
                    configOptions: configOptions(),
                },
            });
            update(sessionId, {
                sessionUpdate: 'available_commands_update',
                availableCommands: [{ name: 'context-gatherer', description: 'Investigates the codebase.', input: { hint: 'task to delegate' } }],
            });
            break;
        }
        case 'session/set_config_option': {
            const { configId, value } = msg.params ?? {};
            if (configId === 'model') {
                model = value;
            } else if (configId === 'mode') {
                mode = value;
            } else {
                send({ id: msg.id, error: { code: -32602, message: `Unknown config option: ${configId}` } });
                break;
            }
            send({ id: msg.id, result: { configOptions: configOptions() } });
            break;
        }
        case '_kiro/session/compact':
            send({ id: msg.id, result: {} });
            break;
        case 'session/prompt':
            void handlePrompt(msg);
            break;
        default:
            // Like V3 for session/set_model and other removed v2 methods
            send({ id: msg.id, error: { code: -32603, message: 'Internal error', data: { details: `Ext method "${msg.method}" is not supported` } } });
    }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        try {
            handle(JSON.parse(line));
        } catch {
            // ignore malformed input
        }
    }
});
process.stdin.on('end', () => process.exit(0));
