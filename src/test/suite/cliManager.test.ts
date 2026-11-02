/**
 * Unit tests for CliManager.
 */

import * as assert from 'assert';
import { CliManager } from '../../cli/cliManager';
import { CliState } from '../../types';

suite('CliManager', () => {
    suite('resolveCliPath', () => {
        test('returns override path when cliPath option is provided', async () => {
            const manager = new CliManager({ cliPath: '/custom/path/kiro' });
            const result = await manager.resolveCliPath();
            assert.strictEqual(result, '/custom/path/kiro');
            assert.strictEqual(manager.resolvedCliPath, '/custom/path/kiro');
            assert.deepStrictEqual(manager.state, { status: 'ready', cliPath: '/custom/path/kiro' });
            manager.dispose();
        });

        test('fires onDidChangeState when path is resolved', async () => {
            const manager = new CliManager({ cliPath: '/test/kiro' });
            const states: CliState[] = [];
            manager.onDidChangeState((s) => states.push(s));
            await manager.resolveCliPath();
            assert.deepStrictEqual(states, [{ status: 'ready', cliPath: '/test/kiro' }]);
            manager.dispose();
        });
    });

    suite('terminalEnv', () => {
        test('is empty without an API key, so kiro-cli uses its own login', () => {
            const manager = new CliManager();
            assert.deepStrictEqual(manager.terminalEnv(), {});
            manager.dispose();
        });

        test('passes a trimmed API key as KIRO_API_KEY', () => {
            const manager = new CliManager();
            manager.setApiKey('  secret-key \n');
            assert.deepStrictEqual(manager.terminalEnv(), { KIRO_API_KEY: 'secret-key' });
            manager.setApiKey(undefined);
            assert.deepStrictEqual(manager.terminalEnv(), {});
            manager.setApiKey('   ');
            assert.deepStrictEqual(manager.terminalEnv(), {});
            manager.dispose();
        });
    });

    suite('state transitions', () => {
        test('initial state is not_found', () => {
            const manager = new CliManager();
            assert.deepStrictEqual(manager.state, { status: 'not_found' });
            manager.dispose();
        });

        test('working directory resolves to an existing path', () => {
            const manager = new CliManager();
            assert.ok(manager.currentWorkingDirectory.length > 0);
            manager.dispose();
        });
    });
});
