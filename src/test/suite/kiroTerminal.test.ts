/**
 * Tests for launching kiro-cli in a terminal and the spec kick-off prompt.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CliManager } from '../../cli/cliManager';
import { KiroTerminalManager, buildTerminalLaunch } from '../../terminal/kiroTerminal';
import { buildSpecPrompt } from '../../spec/specWorkflowManager';

suite('Kiro terminal', () => {
    suite('buildTerminalLaunch', () => {
        test('runs a native Windows binary directly, no shell', () => {
            const exe = 'C:\\Users\\Me\\.local\\bin\\kiro-cli.exe';
            assert.deepStrictEqual(buildTerminalLaunch(exe, ['chat'], 'win32'), { shellPath: exe, shellArgs: ['chat'] });
        });

        test('runs the binary directly on macOS and Linux', () => {
            for (const platform of ['darwin', 'linux'] as const) {
                assert.deepStrictEqual(
                    buildTerminalLaunch('/home/me/.local/bin/kiro-cli', ['chat', '--v3'], platform),
                    { shellPath: '/home/me/.local/bin/kiro-cli', shellArgs: ['chat', '--v3'] }
                );
            }
        });

        test('runs a Windows .cmd shim through cmd.exe /s with one quoted command line', () => {
            const shim = 'C:\\Program Files\\nodejs\\kiro-cli.cmd';
            assert.deepStrictEqual(
                buildTerminalLaunch(shim, ['chat', '--v3', "plan 'x' now"], 'win32', 'C:\\Windows\\System32\\cmd.exe'),
                {
                    shellPath: 'C:\\Windows\\System32\\cmd.exe',
                    // With /s, cmd strips only the outer quotes, leaving: "<shim>" chat --v3 "plan 'x' now"
                    shellArgs: `/d /s /c ""C:\\Program Files\\nodejs\\kiro-cli.cmd" chat --v3 "plan 'x' now""`,
                }
            );
        });

        test('strips cmd metacharacters from shim arguments', () => {
            const launch = buildTerminalLaunch('C:\\x\\kiro-cli.cmd', ['chat', 'fix "a" & b | c > d %PATH% ^!'], 'win32', 'cmd.exe');
            assert.strictEqual(launch.shellArgs, '/d /s /c ""C:\\x\\kiro-cli.cmd" chat "fix a  b  c  d PATH ""');
        });

        test('falls back to cmd.exe when ComSpec is empty', () => {
            assert.strictEqual(buildTerminalLaunch('C:\\x\\kiro-cli.bat', [], 'win32', '').shellPath, 'cmd.exe');
        });
    });

    suite('buildSpecPrompt', () => {
        test('is a single line without double quotes', () => {
            const prompt = buildSpecPrompt('user-login', 'Sign in with "Google"\nand GitHub');
            assert.ok(!prompt.includes('\n'));
            assert.ok(!prompt.includes('"'));
            assert.ok(prompt.includes("Sign in with 'Google' and GitHub"));
        });

        test('names all three files in the spec folder and asks to pause between steps', () => {
            const prompt = buildSpecPrompt('user-login', 'x');
            for (const file of ['requirements.md', 'design.md', 'tasks.md']) {
                assert.ok(prompt.includes(`.kiro/specs/user-login/${file}`), file);
            }
            assert.ok(/stop after each one/.test(prompt));
            assert.ok(/Do not implement anything yet/.test(prompt));
        });
    });

    suite('KiroTerminalManager', () => {
        let sandbox: sinon.SinonSandbox;
        let manager: CliManager;
        let terminals: KiroTerminalManager;
        let created: vscode.TerminalOptions[];
        let fakes: { exitStatus: vscode.TerminalExitStatus | undefined }[];

        setup(async () => {
            sandbox = sinon.createSandbox();
            created = [];
            fakes = [];
            sandbox.stub(vscode.window, 'createTerminal').callsFake(((options: vscode.TerminalOptions) => {
                created.push(options);
                const fake = { show: sandbox.stub(), dispose: sandbox.stub(), name: options.name, exitStatus: undefined };
                fakes.push(fake);
                return fake as unknown as vscode.Terminal;
            }) as never);
            manager = new CliManager({ cliPath: '/opt/kiro/kiro-cli' });
            await manager.resolveCliPath();
            terminals = new KiroTerminalManager(manager, vscode.Uri.file('/ext'));
        });

        teardown(() => {
            terminals.dispose();
            manager.dispose();
            sandbox.restore();
        });

        test('starts kiro-cli chat beside the editor in the working directory', async () => {
            await terminals.open();
            assert.strictEqual(created.length, 1);
            const opts = created[0];
            assert.strictEqual(opts.shellPath, '/opt/kiro/kiro-cli');
            assert.deepStrictEqual(opts.shellArgs, ['chat']);
            assert.strictEqual(opts.cwd, manager.currentWorkingDirectory);
            assert.deepStrictEqual(opts.location, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
            assert.ok(terminals.isRunning);
            assert.strictEqual(terminals.runningDirectory, manager.currentWorkingDirectory);
        });

        test('reuses the open terminal', async () => {
            const first = await terminals.open();
            const second = await terminals.open();
            assert.strictEqual(first, second);
            assert.strictEqual(created.length, 1);
            assert.ok((first!.show as sinon.SinonStub).calledTwice);
        });

        test('terminals are not revived after a window reload', async () => {
            await terminals.open();
            assert.strictEqual((created[0] as vscode.TerminalOptions & { isTransient?: boolean }).isTransient, true);
        });

        test('replaces a terminal whose kiro-cli has exited', async () => {
            const first = await terminals.open();
            fakes[0].exitStatus = { code: 1, reason: vscode.TerminalExitReason.Process };
            assert.strictEqual(terminals.isRunning, false);
            assert.strictEqual(terminals.runningDirectory, undefined);
            const second = await terminals.open();
            assert.notStrictEqual(first, second);
            assert.ok((first!.dispose as sinon.SinonStub).calledOnce);
            assert.strictEqual(created.length, 2);
            assert.ok(terminals.isRunning);
        });

        test('two quick Open Chat calls start one session', async () => {
            const [a, b] = await Promise.all([terminals.open(), terminals.open()]);
            assert.strictEqual(a, b);
            assert.strictEqual(created.length, 1);
        });

        test('counts other (spec) sessions that are still running', async () => {
            await terminals.open();
            await terminals.start({ prompt: 'a' });
            await terminals.start({ prompt: 'b' });
            assert.strictEqual(terminals.otherSessionCount, 2);
            fakes[2].exitStatus = { code: 0, reason: vscode.TerminalExitReason.Process };
            assert.strictEqual(terminals.otherSessionCount, 1);
        });

        test('restart closes the old terminal and starts a new one', async () => {
            const first = await terminals.open();
            const second = await terminals.restart();
            assert.ok((first!.dispose as sinon.SinonStub).calledOnce);
            assert.notStrictEqual(first, second);
            assert.strictEqual(created.length, 2);
        });

        test('passes the API key only through the terminal environment', async () => {
            manager.setApiKey('k-123');
            await terminals.open();
            assert.deepStrictEqual(created[0].env, { KIRO_API_KEY: 'k-123' });
            assert.ok(!(created[0].shellArgs as string[]).some((a) => a.includes('k-123')));
        });

        test('a spec starts its own terminal with the prompt as the first message', async () => {
            await terminals.open();
            await terminals.start({ name: 'Kiro Spec: x', prompt: 'plan it' });
            assert.strictEqual(created.length, 2);
            assert.strictEqual(created[1].name, 'Kiro Spec: x');
            assert.deepStrictEqual(created[1].shellArgs, ['chat', 'plan it']);
        });

        test('adds kiro.chatArguments before the prompt', async () => {
            const config = vscode.workspace.getConfiguration('kiro');
            const realGet = config.get.bind(config);
            sandbox.stub(vscode.workspace, 'getConfiguration').returns({
                ...config,
                get: (key: string, def?: unknown) => (key === 'chatArguments' ? ['--v3', '', 7] : realGet(key, def)),
            } as unknown as vscode.WorkspaceConfiguration);
            await terminals.start({ prompt: 'hi' });
            assert.deepStrictEqual(created[0].shellArgs, ['chat', '--v3', 'hi']);
        });
    });
});
