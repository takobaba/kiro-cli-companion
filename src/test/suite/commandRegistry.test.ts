/**
 * Unit tests for CommandRegistry.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CommandRegistry } from '../../commands/commandRegistry';
import { CliManager } from '../../cli/cliManager';
import { SpecWorkflowManager } from '../../spec/specWorkflowManager';
import { KiroTerminalManager } from '../../terminal/kiroTerminal';

suite('CommandRegistry', () => {
    let sandbox: sinon.SinonSandbox;
    let cliManager: CliManager;
    let terminals: sinon.SinonStubbedInstance<KiroTerminalManager>;
    let specWorkflowManager: sinon.SinonStubbedInstance<SpecWorkflowManager>;
    let showErrorMessageStub: sinon.SinonStub;
    let registerCommandStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        cliManager = new CliManager();
        terminals = sandbox.createStubInstance(KiroTerminalManager);
        specWorkflowManager = sandbox.createStubInstance(SpecWorkflowManager);
        showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves();
        registerCommandStub = sandbox.stub(vscode.commands, 'registerCommand');
        registerCommandStub.callsFake(() => ({ dispose: sandbox.stub() }));
    });

    teardown(() => {
        sandbox.restore();
        cliManager.dispose();
    });

    function register(manager: CliManager = cliManager): CommandRegistry {
        const registry = new CommandRegistry(
            manager,
            terminals as unknown as KiroTerminalManager,
            specWorkflowManager as unknown as SpecWorkflowManager
        );
        registry.registerCommands();
        return registry;
    }

    function handler(id: string): (...args: unknown[]) => Promise<void> {
        const call = registerCommandStub.getCalls().find((c: sinon.SinonSpyCall) => c.args[0] === id);
        assert.ok(call, `${id} should be registered`);
        return call.args[1];
    }

    async function readyManager(): Promise<CliManager> {
        const mgr = new CliManager({ cliPath: '/usr/bin/kiro' });
        await mgr.resolveCliPath();
        return mgr;
    }

    test('registers all commands', () => {
        const registry = new CommandRegistry(
            cliManager,
            terminals as unknown as KiroTerminalManager,
            specWorkflowManager as unknown as SpecWorkflowManager
        );
        const disposables = registry.registerCommands();
        const ids = registerCommandStub.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
        assert.deepStrictEqual(ids, [
            'kiro.openChat',
            'kiro.startSpec',
            'kiro.restartCli',
            'kiro.login',
            'kiro.selectWorkingDirectory',
        ]);
        assert.strictEqual(disposables.length, ids.length);
        registry.dispose();
    });

    suite('CLI not found', () => {
        test('kiro.openChat shows an error and opens no terminal', async () => {
            sandbox.stub(cliManager, 'resolveCliPath').resolves(null);
            const registry = register();
            await handler('kiro.openChat')();
            assert.ok(showErrorMessageStub.calledOnce);
            assert.ok(/not found/i.test(showErrorMessageStub.firstCall.args[0] as string));
            assert.ok(terminals.open.notCalled);
            registry.dispose();
        });

        test('kiro.startSpec shows an error and starts no workflow', async () => {
            sandbox.stub(cliManager, 'resolveCliPath').resolves(null);
            const registry = register();
            await handler('kiro.startSpec')();
            assert.ok(showErrorMessageStub.calledOnce);
            assert.ok(specWorkflowManager.startWorkflow.notCalled);
            registry.dispose();
        });

        test('kiro.openChat works once the CLI is installed, without a reload', async () => {
            sandbox.stub(cliManager, 'resolveCliPath').resolves('/now/installed/kiro-cli');
            const registry = register();
            await handler('kiro.openChat')();
            assert.ok(showErrorMessageStub.notCalled);
            assert.ok(terminals.open.calledOnce);
            registry.dispose();
        });

        test('kiro.restartCli shows an error and does not restart', async () => {
            sandbox.stub(cliManager, 'resolveCliPath').resolves(null);
            const registry = register();
            await handler('kiro.restartCli')();
            assert.ok(/not found/i.test(showErrorMessageStub.firstCall.args[0] as string));
            assert.ok(terminals.restart.notCalled);
            registry.dispose();
        });
    });

    suite('CLI available', () => {
        test('kiro.openChat opens the Kiro terminal', async () => {
            const mgr = await readyManager();
            const registry = register(mgr);
            await handler('kiro.openChat')();
            assert.ok(terminals.open.calledOnce);
            assert.ok(showErrorMessageStub.notCalled);
            registry.dispose();
            mgr.dispose();
        });

        test('kiro.startSpec starts the workflow', async () => {
            const mgr = await readyManager();
            const registry = register(mgr);
            await handler('kiro.startSpec')();
            assert.ok(specWorkflowManager.startWorkflow.calledOnce);
            registry.dispose();
            mgr.dispose();
        });

        test('kiro.restartCli restarts the terminal when authenticated', async () => {
            const mgr = await readyManager();
            sandbox.stub(mgr, 'checkAuthentication').resolves(true);
            const login = sandbox.stub(mgr, 'login');
            const registry = register(mgr);
            await handler('kiro.restartCli')();
            assert.ok(login.notCalled);
            assert.ok(terminals.restart.calledOnce);
            registry.dispose();
            mgr.dispose();
        });

        test('kiro.restartCli logs in first when not authenticated', async () => {
            const mgr = await readyManager();
            sandbox.stub(mgr, 'checkAuthentication').resolves(false);
            const login = sandbox.stub(mgr, 'login').resolves(true);
            const registry = register(mgr);
            await handler('kiro.restartCli')();
            assert.ok(login.calledOnce);
            assert.ok(terminals.restart.calledOnce);
            registry.dispose();
            mgr.dispose();
        });

        test('kiro.restartCli does not restart when login fails', async () => {
            const mgr = await readyManager();
            sandbox.stub(mgr, 'checkAuthentication').resolves(false);
            sandbox.stub(mgr, 'login').resolves(false);
            const registry = register(mgr);
            await handler('kiro.restartCli')();
            assert.ok(terminals.restart.notCalled);
            assert.ok(/login failed/i.test(showErrorMessageStub.firstCall.args[0] as string));
            registry.dispose();
            mgr.dispose();
        });
    });

    suite('kiro.selectWorkingDirectory', () => {
        test('does nothing when the picker is cancelled', async () => {
            sandbox.stub(cliManager, 'selectWorkingDirectory').resolves(undefined);
            const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves();
            const registry = register();
            await handler('kiro.selectWorkingDirectory')();
            assert.ok(info.notCalled);
            assert.ok(terminals.restart.notCalled);
            registry.dispose();
        });

        test('offers to restart a chat running in another folder', async () => {
            sandbox.stub(cliManager, 'selectWorkingDirectory').resolves('/new/dir');
            sandbox.stub(terminals, 'runningDirectory').get(() => '/old/dir');
            const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves('Restart Chat There' as never);
            const registry = register();
            await handler('kiro.selectWorkingDirectory')();
            assert.ok(/still working in/.test(info.firstCall.args[0] as string));
            assert.ok(terminals.restart.calledOnce);
            registry.dispose();
        });

        test('keeps the running chat when the user says so', async () => {
            sandbox.stub(cliManager, 'selectWorkingDirectory').resolves('/new/dir');
            sandbox.stub(terminals, 'runningDirectory').get(() => '/old/dir');
            sandbox.stub(vscode.window, 'showInformationMessage').resolves('Keep Current Chat' as never);
            const registry = register();
            await handler('kiro.selectWorkingDirectory')();
            assert.ok(terminals.restart.notCalled);
            registry.dispose();
        });
    });

    test('dispose disposes all registered commands', () => {
        const disposeStubs: sinon.SinonStub[] = [];
        registerCommandStub.callsFake(() => {
            const dispose = sandbox.stub();
            disposeStubs.push(dispose);
            return { dispose };
        });
        const registry = register();
        registry.dispose();
        assert.ok(disposeStubs.length > 0);
        disposeStubs.forEach((stub, i) => assert.ok(stub.calledOnce, `Disposable ${i} should be disposed`));
    });
});
