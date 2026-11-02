/**
 * Tests for the CLI V3 adapter: launch flags, permission requests and
 * consent, config options, slash commands and permission files.
 * Process tests run test-fixtures/fake-kiro-cli.js, which mirrors the real
 * V3 server (and refuses to start without --agent-engine=v3).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CliManager } from '../../cli/cliManager';
import { ACP_ARGS, PermissionRequest, buildPermissionResult, parseContextUsage } from '../../cli/cliProcess';
import { ChatPanelProvider } from '../../chat/chatPanelProvider';
import { parseSlashCommand } from '../../chat/slashCommands';
import {
    normalizeWorkspaceRoot,
    readPermissionsFile,
    summarize,
    workspaceRootHash,
} from '../../permissions/permissions';
import { fakeCliPath } from './fakeCli';

const shellRequest = (): PermissionRequest => ({
    sessionId: 's1',
    toolCallId: 'call-1',
    title: 'npm run test',
    options: [
        { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always-accept', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
    ],
    consent: { capability: 'shell', resource: 'npm run test', triggeringResource: 'npm run test', workspaceRoot: '/ws', askType: 'implicit' },
});

suite('CLI V3 adapter', function () {
    this.timeout(15000);

    suite('launch', () => {
        test('starts the V3 ACP engine', () => {
            assert.deepStrictEqual(ACP_ARGS, ['acp', '--agent-engine=v3']);
        });
    });

    suite('buildPermissionResult', () => {
        test('a one-time choice returns only the selected option', () => {
            assert.deepStrictEqual(buildPermissionResult(shellRequest(), { optionId: 'accept' }), {
                outcome: { outcome: 'selected', optionId: 'accept' },
            });
        });

        test('an "always" choice carries canonical consent for the chosen scope', () => {
            assert.deepStrictEqual(buildPermissionResult(shellRequest(), { optionId: 'always-accept', scope: 'workspace' }), {
                outcome: { outcome: 'selected', optionId: 'always-accept' },
                _meta: { kiro: { consent: { scope: 'workspace', resource: 'npm run test', workspaceRoot: '/ws' } } },
            });
        });

        test('an "always" choice without a scope stays in the session', () => {
            const result = buildPermissionResult(shellRequest(), { optionId: 'always-accept' }) as { _meta: { kiro: { consent: { scope: string } } } };
            assert.strictEqual(result._meta.kiro.consent.scope, 'session');
        });

        test('never returns an option the agent did not offer', () => {
            assert.deepStrictEqual(buildPermissionResult(shellRequest(), { optionId: 'always-reject' }), {
                outcome: { outcome: 'cancelled' },
            });
        });

        test('cancel returns the cancelled outcome', () => {
            assert.deepStrictEqual(buildPermissionResult(shellRequest(), { cancelled: true }), { outcome: { outcome: 'cancelled' } });
        });
    });

    suite('parseContextUsage', () => {
        test('reads usagePercentage and the breakdown', () => {
            assert.deepStrictEqual(
                parseContextUsage({
                    kind: 'context_usage',
                    usagePercentage: 10,
                    breakdown: { yourPrompts: { percent: 2 }, kiroResponses: { percent: 3 }, contextFiles: { percent: 4 }, tools: { mcp: { percent: 1 } } },
                }),
                { total: 10, conversation: 5, mcpTools: 1, steeringFiles: 4 }
            );
        });

        test('returns null without a percentage', () => {
            assert.strictEqual(parseContextUsage({ kind: 'context_usage' }), null);
        });
    });

    suite('parseSlashCommand', () => {
        test('routes model, mode, plan and effort to config options', () => {
            assert.deepStrictEqual(parseSlashCommand('/model claude-sonnet-5.5', []), { kind: 'setOption', configId: 'model', label: 'Model', value: 'claude-sonnet-5.5' });
            assert.deepStrictEqual(parseSlashCommand('/agent', []), { kind: 'setOption', configId: 'mode', label: 'Mode', value: undefined });
            assert.deepStrictEqual(parseSlashCommand('/plan add a cache', []), { kind: 'setOption', configId: 'mode', label: 'Mode', value: 'plan', then: 'add a cache' });
            assert.deepStrictEqual(parseSlashCommand('/effort high', []), { kind: 'setOption', configId: 'effortLevel', label: 'Effort', value: 'high' });
        });

        test('advertised commands are sent to the agent as typed', () => {
            assert.deepStrictEqual(parseSlashCommand('/context-gatherer how does auth work', ['context-gatherer']), {
                kind: 'agentCommand',
                text: '/context-gatherer how does auth work',
            });
        });

        test('local commands and unknown commands', () => {
            assert.deepStrictEqual(parseSlashCommand('/permissions', []), { kind: 'permissions' });
            assert.deepStrictEqual(parseSlashCommand('/tools', []), { kind: 'permissions' });
            assert.deepStrictEqual(parseSlashCommand('/compact', []), { kind: 'compact' });
            assert.deepStrictEqual(parseSlashCommand('/nope', []), { kind: 'unknown', name: 'nope' });
        });

        test('paths are not commands', () => {
            assert.strictEqual(parseSlashCommand('/usr/bin is a folder', []), null);
            assert.strictEqual(parseSlashCommand('hello', []), null);
        });
    });

    suite('permission files', () => {
        test('normalizes workspace roots like kiro-cli', () => {
            assert.strictEqual(normalizeWorkspaceRoot('C:\\Users\\Me\\Repo\\', 'win32'), 'c:/users/me/repo');
            assert.strictEqual(normalizeWorkspaceRoot('C:\\', 'win32'), 'c:/');
            assert.strictEqual(normalizeWorkspaceRoot('/home/me/repo/', 'linux'), '/home/me/repo');
            assert.strictEqual(normalizeWorkspaceRoot('/home/Me/../Me/Repo', 'linux'), '/home/Me/Repo');
        });

        test('hashes the workspace root like kiro-cli', () => {
            // Recorded from kiro-cli 2.37.1: ~/.kiro/workspace-roots/5fad8110355fd5ba
            assert.strictEqual(workspaceRootHash('C:\\Users\\Administrator\\Documents\\kiro-cli-companion', 'win32'), '5fad8110355fd5ba');
            assert.strictEqual(
                workspaceRootHash('c:/users/administrator/documents/kiro-cli-companion/', 'win32'),
                workspaceRootHash('C:\\Users\\Administrator\\Documents\\kiro-cli-companion', 'win32')
            );
        });

        test('summarizes rules and policies in YAML', () => {
            const yaml = [
                '# comment',
                'rules:',
                '  - capability: shell',
                '    match: ["git *", "npm *"]',
                '    effect: allow',
                '  - capability: fs_write',
                '    match:',
                '      - "*.env"',
                '    effect: deny',
                'policies:',
                '  - approve-for-me',
                'workspaceTrusted: true',
            ].join('\n');
            assert.deepStrictEqual(summarize(yaml, false), { ruleCount: 2, policies: ['approve-for-me'] });
            assert.deepStrictEqual(summarize('rules: []\nworkspaceTrusted: true\n', false), { ruleCount: 0, policies: [] });
            assert.deepStrictEqual(summarize('rules:\n- capability: all\n  effect: allow\npolicies: [dev-shell]\n', false), { ruleCount: 1, policies: ['dev-shell'] });
        });

        test('summarizes JSON and reports missing files', () => {
            assert.deepStrictEqual(summarize('{"rules":[{},{}],"policies":["read-workspace"]}', true), { ruleCount: 2, policies: ['read-workspace'] });
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-perm-'));
            try {
                const missing = readPermissionsFile('user', dir);
                assert.strictEqual(missing.exists, false);
                assert.strictEqual(missing.filePath, path.join(dir, 'permissions.yaml'));
                fs.writeFileSync(path.join(dir, 'permissions.json'), '{"rules":[{}]}');
                const found = readPermissionsFile('user', dir);
                assert.strictEqual(found.exists, true);
                assert.strictEqual(found.ruleCount, 1);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    suite('CliProcess against the V3 fake', () => {
        async function startProcess() {
            const manager = new CliManager({ cliPath: fakeCliPath() });
            await manager.resolveCliPath();
            return { manager, proc: await manager.ensureProcess() };
        }

        test('changes the model with session/set_config_option', async () => {
            const { manager, proc } = await startProcess();
            const options = await proc.setConfigOption('model', 'claude-sonnet-5.5');
            assert.strictEqual(options.find((o) => o.id === 'model')?.currentValue, 'claude-sonnet-5.5');
            assert.ok(proc.hasExtensionMethod('_kiro/session/compact'));
            assert.ok(!proc.hasExtensionMethod('_kiro/session/export'));
            manager.dispose();
        });

        test('answers a permission request with id 0 and sends consent', async () => {
            const { manager, proc } = await startProcess();
            const seen: PermissionRequest[] = [];
            proc.onPermissionRequest = async (request) => {
                seen.push(request);
                return { optionId: 'always-accept', scope: 'workspace' };
            };
            let usage = 0;
            proc.onContextUsage = (u) => { usage = u.total; };
            const chunks: string[] = [];
            await proc.sendPrompt('RUN:npm test', (u) => {
                const text = (u.content as { text?: string } | undefined)?.text;
                if (text) {
                    chunks.push(text);
                }
            });
            assert.strictEqual(seen.length, 1);
            assert.strictEqual(seen[0].consent?.capability, 'shell');
            assert.strictEqual(chunks.join(''), 'permission: always-accept scope=workspace resource=npm test');
            assert.strictEqual(usage, 12.5);
            assert.ok(proc.availableCommands.some((c) => c.name === 'context-gatherer'));
            manager.dispose();
        });

        test('denies once when nobody can answer', async () => {
            const { manager, proc } = await startProcess();
            const chunks: string[] = [];
            await proc.sendPrompt('RUN:rm -rf build', (u) => {
                const text = (u.content as { text?: string } | undefined)?.text;
                if (text) {
                    chunks.push(text);
                }
            });
            assert.strictEqual(chunks.join(''), 'permission: reject');
            manager.dispose();
        });
    });

    suite('chat panel', () => {
        let sandbox: sinon.SinonSandbox;
        let manager: CliManager;
        let provider: ChatPanelProvider;
        let posted: any[];
        let onMessage: (m: unknown) => void;

        setup(async () => {
            sandbox = sinon.createSandbox();
            posted = [];
            const fakePanel = {
                webview: {
                    postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true); },
                    html: '',
                    onDidReceiveMessage: (cb: (m: unknown) => void) => { onMessage = cb; return { dispose: () => undefined }; },
                    cspSource: '',
                    asWebviewUri: () => vscode.Uri.parse('https://fake'),
                },
                reveal: () => undefined,
                onDidDispose: () => ({ dispose: () => undefined }),
                onDidChangeViewState: () => ({ dispose: () => undefined }),
                dispose: () => undefined,
            };
            sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
            sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
            manager = new CliManager({ cliPath: fakeCliPath() });
            await manager.resolveCliPath();
            provider = new ChatPanelProvider(vscode.Uri.file(path.resolve(__dirname, '..', '..', '..')), manager);
            provider.openPanel();
        });

        teardown(() => {
            provider.dispose();
            manager.dispose();
            sandbox.restore();
        });

        const waitFor = async <T>(find: () => T | undefined): Promise<T> => {
            for (let i = 0; i < 200; i++) {
                const v = find();
                if (v) {
                    return v;
                }
                await new Promise((r) => setTimeout(r, 25));
            }
            throw new Error('timed out');
        };
        const responseText = () => posted.filter((m) => m.type === 'response').map((m) => m.content).join('');

        test('shows a permission card and sends the user\'s choice', async () => {
            const turn = provider.handleUserMessage('RUN:npm test');
            const card = await waitFor(() => posted.find((m) => m.type === 'permissionRequest'));
            assert.strictEqual(card.request.capability, 'shell');
            assert.strictEqual(card.request.resource, 'npm test');
            assert.deepStrictEqual(card.request.options.map((o: { optionId: string }) => o.optionId), ['accept', 'always-accept', 'reject', 'always-reject']);
            assert.deepStrictEqual(card.request.scopes, ['workspace', 'user', 'session']);

            onMessage({ type: 'permissionResponse', requestId: card.request.requestId, optionId: 'always-accept', scope: 'user' });
            await turn;
            await provider.whenIdle();
            assert.ok(responseText().includes('permission: always-accept scope=user resource=npm test'), responseText());
            const resolved = posted.find((m) => m.type === 'permissionResolved');
            assert.strictEqual(resolved.label, 'Always allow (all projects)');
        });

        test('clearing the chat cancels a pending permission', async () => {
            const turn = provider.handleUserMessage('RUN:npm test');
            const card = await waitFor(() => posted.find((m) => m.type === 'permissionRequest'));
            onMessage({ type: 'clearChat' });
            // The turn must finish (kiro-cli got an answer) rather than hang
            await turn;
            await provider.whenIdle();
            const resolved = posted.find((m) => m.type === 'permissionResolved');
            assert.deepStrictEqual(resolved, { type: 'permissionResolved', requestId: card.request.requestId, label: 'Cancelled' });
        });

        test('/model changes the model through set_config_option', async () => {
            await provider.handleUserMessage('/model claude-sonnet-5.5');
            await provider.whenIdle();
            assert.ok(posted.some((m) => m.type === 'systemMessage' && m.message === 'Model changed to Claude Sonnet 5.5'), JSON.stringify(posted));
            assert.strictEqual(manager.state.status, 'running');
            if (manager.state.status === 'running') {
                assert.strictEqual(manager.state.process.configOptions.find((o) => o.id === 'model')?.currentValue, 'claude-sonnet-5.5');
            }
        });

        test('/plan with text switches mode and sends the request', async () => {
            await provider.handleUserMessage('/plan add a cache');
            await provider.whenIdle();
            assert.ok(posted.some((m) => m.type === 'systemMessage' && m.message === 'Mode changed to Plan'));
            assert.ok(responseText().includes('add a cache'), responseText());
        });

        test('/context is answered locally from the latest usage', async () => {
            await provider.handleUserMessage('hello');
            await provider.handleUserMessage('/context');
            await provider.whenIdle();
            const msg = posted.find((m) => m.type === 'systemMessage' && /^Context window/.test(m.message));
            assert.ok(msg, JSON.stringify(posted));
            assert.ok(msg.message.startsWith('Context window: 13% used'), msg.message);
            assert.ok(!responseText().includes('echo: /context'), 'should not reach the model');
        });
    });
});
