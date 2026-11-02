/**
 * Unit tests for CliManager. Process tests use a fake kiro-cli that speaks
 * ACP (see test-fixtures/fake-kiro-cli.js).
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { CliManager } from '../../cli/cliManager';
import { CliState } from '../../types';
import { fakeCliPath } from './fakeCli';

suite('CliManager', function () {
    // Spawning a process + ACP handshake can take a moment on CI machines
    this.timeout(15000);

    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    async function readyManager(): Promise<CliManager> {
        const manager = new CliManager({ cliPath: fakeCliPath() });
        await manager.resolveCliPath();
        return manager;
    }

    suite('resolveCliPath', () => {
        test('returns override path when cliPath option is provided', async () => {
            const manager = new CliManager({ cliPath: '/custom/path/kiro' });
            const result = await manager.resolveCliPath();
            assert.strictEqual(result, '/custom/path/kiro');
            assert.deepStrictEqual(manager.state, { status: 'ready', cliPath: '/custom/path/kiro' });
            manager.dispose();
        });

        test('fires onDidChangeState when path is resolved', async () => {
            const manager = new CliManager({ cliPath: '/test/kiro' });
            const states: CliState[] = [];
            manager.onDidChangeState((s) => states.push(s));

            await manager.resolveCliPath();

            assert.strictEqual(states.length, 1);
            assert.deepStrictEqual(states[0], { status: 'ready', cliPath: '/test/kiro' });
            manager.dispose();
        });
    });

    suite('ensureProcess', () => {
        test('throws if the CLI cannot be found', async () => {
            const manager = new CliManager();
            sandbox.stub(manager, 'resolveCliPath').resolves(null);
            await assert.rejects(() => manager.ensureProcess(), /not found/i);
            manager.dispose();
        });

        test('fires onDidChangeState to running when process is spawned', async () => {
            const manager = await readyManager();
            const states: CliState[] = [];
            manager.onDidChangeState((s) => states.push(s));

            const proc = await manager.ensureProcess();
            assert.ok(proc.sessionId, 'Expected an ACP session id');

            const running = states.find((s) => s.status === 'running');
            assert.ok(running, 'Expected a running state transition');
            manager.dispose();
        });

        test('reuses existing process if alive', async () => {
            const manager = await readyManager();
            const proc1 = await manager.ensureProcess();
            const proc2 = await manager.ensureProcess();
            assert.strictEqual(proc1, proc2, 'Should reuse the same process');
            manager.dispose();
        });

        test('concurrent calls share one spawn', async () => {
            const manager = await readyManager();
            const [a, b] = await Promise.all([manager.ensureProcess(), manager.ensureProcess()]);
            assert.strictEqual(a, b, 'Both callers should get the same process');
            manager.dispose();
        });

        test('round-trips a prompt and exposes models/agents from session/new', async () => {
            const manager = await readyManager();
            const proc = await manager.ensureProcess();
            const chunks: string[] = [];
            await proc.sendPrompt('hello', (u) => {
                const content = u.content as { text?: string } | undefined;
                if (content?.text) {
                    chunks.push(content.text);
                }
            });
            assert.strictEqual(chunks.join(''), 'echo: hello');
            assert.deepStrictEqual(
                proc.configOptions.map((o) => `${o.category}:${o.currentValue}`),
                ['mode:vibe', 'model:auto']
            );
            manager.dispose();
        });
    });

    suite('restartProcess', () => {
        test('returns a new process after restart', async () => {
            const manager = await readyManager();
            const proc1 = await manager.ensureProcess();
            const proc2 = await manager.restartProcess();
            assert.notStrictEqual(proc1, proc2, 'Should return a different process');
            manager.dispose();
        });
    });

    suite('dispose', () => {
        test('terminates the running process', async () => {
            const manager = await readyManager();
            const proc = await manager.ensureProcess();
            assert.ok(proc.isAlive, 'Process should be alive before dispose');

            const exited = new Promise<void>((resolve) => proc.onDidExit(() => resolve()));
            manager.dispose();
            await exited;
            assert.ok(!proc.isAlive, 'Process should not be alive after dispose');
        });
    });

    suite('state transitions', () => {
        test('initial state is not_found', () => {
            const manager = new CliManager();
            assert.deepStrictEqual(manager.state, { status: 'not_found' });
            manager.dispose();
        });

        test('transitions to ready after resolveCliPath', async () => {
            const manager = new CliManager({ cliPath: '/test/kiro' });
            await manager.resolveCliPath();
            assert.strictEqual(manager.state.status, 'ready');
            manager.dispose();
        });
    });
});
