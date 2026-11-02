/**
 * Unit tests for CommandRegistry.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { CommandRegistry } from '../../commands/commandRegistry';
import { CliManager } from '../../cli/cliManager';
import { ChatPanelProvider } from '../../chat/chatPanelProvider';
import { SpecWorkflowManager } from '../../spec/specWorkflowManager';

suite('CommandRegistry', () => {
    let sandbox: sinon.SinonSandbox;
    let cliManager: CliManager;
    let chatPanelProvider: sinon.SinonStubbedInstance<ChatPanelProvider>;
    let specWorkflowManager: sinon.SinonStubbedInstance<SpecWorkflowManager>;
    let showErrorMessageStub: sinon.SinonStub;
    let registerCommandStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();

        cliManager = new CliManager();

        chatPanelProvider = sandbox.createStubInstance(ChatPanelProvider);
        specWorkflowManager = sandbox.createStubInstance(SpecWorkflowManager);

        showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves();
        registerCommandStub = sandbox.stub(vscode.commands, 'registerCommand');
        registerCommandStub.callsFake((_id: string, _cb: Function) => ({
            dispose: sandbox.stub(),
        }));
    });

    teardown(() => {
        sandbox.restore();
    });

    suite('registerCommands', () => {
        test('registers all commands', () => {
            const registry = new CommandRegistry(
                cliManager,
                chatPanelProvider as unknown as ChatPanelProvider,
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

        test('selectWorkingDirectory refuses to change the folder once the conversation started', async () => {
            Object.defineProperty(chatPanelProvider, 'isWorkingDirectoryLocked', { value: true });
            const pick = sandbox.stub(cliManager, 'selectWorkingDirectory').resolves('/elsewhere');
            const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves();
            const registry = new CommandRegistry(
                cliManager,
                chatPanelProvider as unknown as ChatPanelProvider,
                specWorkflowManager as unknown as SpecWorkflowManager
            );
            registry.registerCommands();
            const handler = registerCommandStub.getCalls()
                .find((c: sinon.SinonSpyCall) => c.args[0] === 'kiro.selectWorkingDirectory')!.args[1];

            await handler();

            assert.ok(pick.notCalled, 'folder picker must not open');
            assert.ok(/Clear the chat/.test(info.firstCall.args[0] as string), 'user is told how to change it');
            registry.dispose();
        });

        test('selectWorkingDirectory opens the picker before the conversation starts', async () => {
            Object.defineProperty(chatPanelProvider, 'isWorkingDirectoryLocked', { value: false });
            const pick = sandbox.stub(cliManager, 'selectWorkingDirectory').resolves(undefined);
            const registry = new CommandRegistry(
                cliManager,
                chatPanelProvider as unknown as ChatPanelProvider,
                specWorkflowManager as unknown as SpecWorkflowManager
            );
            registry.registerCommands();
            const handler = registerCommandStub.getCalls()
                .find((c: sinon.SinonSpyCall) => c.args[0] === 'kiro.selectWorkingDirectory')!.args[1];

            await handler();

            assert.ok(pick.calledOnce);
            registry.dispose();
        });

        test('returns disposable array', () => {
            const registry = new CommandRegistry(
                cliManager,
                chatPanelProvider as unknown as ChatPanelProvider,
                specWorkflowManager as unknown as SpecWorkflowManager
            );

            const disposables = registry.registerCommands();

            assert.ok(Array.isArray(disposables));
            disposables.forEach((d) => assert.ok(typeof d.dispose === 'function'));

            registry.dispose();
        });
    });

    suite('command guard - CLI not found', () => {
        test('kiro.openChat shows error when CLI not found', async () => {
            // The guard re-runs discovery before failing; make it find nothing
            sandbox.stub(cliManager, 'resolveCliPath').resolves(null);
            const registry = new CommandRegistry(
                cliManager,
                chatPanelProvider as unknown as ChatPanelProvider,
                specWorkflowManager as unknown as SpecWorkflowManager
            );

            registry.registerCommands();

            // Get the callback registered for kiro.openChat and invoke it
            const openChatCall = registerCommandStub.getCalls().find(
                (c: sinon.SinonSpyCall) => c.args[0] === 'kiro.openChat'
            );
            assert.ok(openChatCall, 'kiro.openChat should be registered');
            await openChatCall.args[1](); // invoke the handler

            assert.ok(showErrorMessageStub.calledOnce, 'Should show error message');
            assert.ok(
                /not found/i.test(showErrorMessageStub.firstCall.args[0] as string),
                'Error message should mention CLI not found'
            );
            assert.ok(
                chatPanelProvider.openPanel.notCalled,
                'openPanel should not be called when CLI is not found'
            );

            registry.dispose();
        });

        test('kiro.startSpec shows error when CLI not found', async () => {
            sandbox.stub(cliManager, 'resolveCliPath').resolves(null);
            const registry = new CommandRegistry(
                cliManager,
                chatPanelProvider as unknown as ChatPanelProvider,
                specWorkflowManager as unknown as SpecWorkflowManager
            );

            registry.registerCommands();

            const startSpecCall = registerCommandStub.getCalls().find(
                (c: sinon.SinonSpyCall) => c.args[0] === 'kiro.startSpec'
            );
            assert.ok(startSpecCall);
            await startSpecCall.args[1]();

            assert.ok(showErrorMessageStub.calledOnce);
            assert.ok(
                specWorkflowManager.startWorkflow.notCalled,
                'startWorkflow should not be called when CLI is not found'
            );

            registry.dispose();
        });

        test('kiro.restartCli reports CLI not found in the chat', async () => {
            sandbox.stub(cliManager, 'resolveCliPath').resolves(null);
            const restartStub = sandbox.stub(cliManager, 'restartProcess');
            const registry = new CommandRegistry(
                cliManager,
                chatPanelProvider as unknown as ChatPanelProvider,
                specWorkflowManager as unknown as SpecWorkflowManager
            );

            registry.registerCommands();

            const restartCall = registerCommandStub.getCalls().find(
                (c: sinon.SinonSpyCall) => c.args[0] === 'kiro.restartCli'
            );
            assert.ok(restartCall);
            await restartCall.args[1]();

            const errorPost = chatPanelProvider.postMessage.getCalls().find(
                (c: sinon.SinonSpyCall) => c.args[0]?.type === 'error'
            );
            assert.ok(errorPost, 'Should post an error to the chat');
            assert.ok(/not found/i.test((errorPost!.args[0] as { message: string }).message), 'Error should say the CLI was not found');
            assert.ok(restartStub.notCalled, 'restartProcess should not be called when CLI is not found');

            registry.dispose();
        });
    });

    suite('command execution - CLI available', () => {
        test('kiro.openChat calls openPanel when CLI is ready', async () => {
            // Resolve CLI path to move state away from not_found
            const mgr = new CliManager({ cliPath: '/usr/bin/kiro' });
            await mgr.resolveCliPath();

            const registry = new CommandRegistry(
                mgr,
                chatPanelProvider as unknown as ChatPanelProvider,
                specWorkflowManager as unknown as SpecWorkflowManager
            );

            registry.registerCommands();

            const openChatCall = registerCommandStub.getCalls().find(
                (c: sinon.SinonSpyCall) => c.args[0] === 'kiro.openChat'
            );
            openChatCall!.args[1]();

            assert.ok(chatPanelProvider.openPanel.calledOnce, 'openPanel should be called');
            assert.ok(showErrorMessageStub.notCalled, 'No error should be shown');

            registry.dispose();
            mgr.dispose();
        });

        test('kiro.startSpec calls startWorkflow when CLI is ready', async () => {
            const mgr = new CliManager({ cliPath: '/usr/bin/kiro' });
            await mgr.resolveCliPath();

            const registry = new CommandRegistry(
                mgr,
                chatPanelProvider as unknown as ChatPanelProvider,
                specWorkflowManager as unknown as SpecWorkflowManager
            );

            registry.registerCommands();

            const startSpecCall = registerCommandStub.getCalls().find(
                (c: sinon.SinonSpyCall) => c.args[0] === 'kiro.startSpec'
            );
            startSpecCall!.args[1]();

            assert.ok(specWorkflowManager.startWorkflow.calledOnce, 'startWorkflow should be called');
            assert.ok(showErrorMessageStub.notCalled);

            registry.dispose();
            mgr.dispose();
        });

        test('kiro.restartCli calls restartProcess when CLI is ready', async () => {
            const mgr = new CliManager({ cliPath: '/usr/bin/kiro' });
            await mgr.resolveCliPath();

            const restartStub = sandbox.stub(mgr, 'restartProcess').resolves({} as any);
            // Skip the real `kiro-cli whoami` call
            sandbox.stub(mgr, 'checkAuthentication').resolves(true);

            const registry = new CommandRegistry(
                mgr,
                chatPanelProvider as unknown as ChatPanelProvider,
                specWorkflowManager as unknown as SpecWorkflowManager
            );

            registry.registerCommands();

            const restartCall = registerCommandStub.getCalls().find(
                (c: sinon.SinonSpyCall) => c.args[0] === 'kiro.restartCli'
            );
            await restartCall!.args[1]();

            assert.ok(restartStub.calledOnce, 'restartProcess should be called');
            assert.ok(showErrorMessageStub.notCalled);

            registry.dispose();
            mgr.dispose();
        });
    });

    suite('dispose', () => {
        test('disposes all registered command disposables', () => {
            const disposeStubs: sinon.SinonStub[] = [];
            registerCommandStub.callsFake(() => {
                const dispose = sandbox.stub();
                disposeStubs.push(dispose);
                return { dispose };
            });

            const registry = new CommandRegistry(
                cliManager,
                chatPanelProvider as unknown as ChatPanelProvider,
                specWorkflowManager as unknown as SpecWorkflowManager
            );

            registry.registerCommands();
            registry.dispose();

            disposeStubs.forEach((stub, i) => {
                assert.ok(stub.calledOnce, `Disposable ${i} should be disposed`);
            });
        });
    });
});
