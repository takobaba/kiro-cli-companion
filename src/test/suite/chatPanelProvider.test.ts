/**
 * Unit tests for ChatPanelProvider retry logic.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ChatPanelProvider } from '../../chat/chatPanelProvider';
import { CliManager } from '../../cli/cliManager';

suite('ChatPanelProvider - Retry Logic', () => {
    let sandbox: sinon.SinonSandbox;
    let provider: ChatPanelProvider;
    let cliManager: sinon.SinonStubbedInstance<CliManager>;
    let showErrorMessageStub: sinon.SinonStub;
    let fakeWebview: { postMessage: sinon.SinonStub; html: string; onDidReceiveMessage: sinon.SinonStub; cspSource: string; asWebviewUri: sinon.SinonStub };
    let fakePanel: any;

    /** Minimal stand-in for a running CliProcess whose prompts succeed. */
    const fakeProcess = () => ({
        sendPrompt: sandbox.stub().resolves({ stopReason: 'end_turn' }),
        configOptions: [],
        sessionId: 'fake-session',
    }) as any;

    setup(() => {
        sandbox = sinon.createSandbox();

        cliManager = sandbox.createStubInstance(CliManager);
        // createStubInstance doesn't stub instance fields such as events
        (cliManager as any).onDidChangeState = sandbox.stub().returns({ dispose: () => undefined });

        showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);

        fakeWebview = {
            postMessage: sandbox.stub().resolves(),
            html: '',
            onDidReceiveMessage: sandbox.stub(),
            cspSource: '',
            asWebviewUri: sandbox.stub().returns(vscode.Uri.parse('https://fake')),
        };

        fakePanel = {
            webview: fakeWebview,
            reveal: sandbox.stub(),
            onDidDispose: sandbox.stub(),
            onDidChangeViewState: sandbox.stub(),
            dispose: sandbox.stub(),
        };

        sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);

        // Stub fs.readFileSync to return minimal HTML
        const fsModule = require('fs');
        sandbox.stub(fsModule, 'readFileSync').returns('<html></html>');

        const extensionUri = vscode.Uri.file('/fake/extension');
        provider = new ChatPanelProvider(
            extensionUri,
            cliManager as unknown as CliManager
        );

        // Open the panel so _panel is set
        provider.openPanel();
    });

    teardown(() => {
        provider.dispose();
        sandbox.restore();
    });

    test('stores last failed message on communication error', async () => {
        cliManager.ensureProcess.rejects(new Error('Connection refused'));

        await provider.handleUserMessage('hello world');

        // Should show VS Code error notification with Retry action
        assert.ok(showErrorMessageStub.calledOnce, 'Should show error message');
        const errorMsg = showErrorMessageStub.firstCall.args[0] as string;
        assert.ok(errorMsg.includes('Communication error'), 'Should include "Communication error" prefix');
        assert.ok(errorMsg.includes('Connection refused'), 'Should include original error message');
        assert.strictEqual(showErrorMessageStub.firstCall.args[1], 'Retry', 'Should offer Retry action');
    });

    test('retries the failed message when user clicks Retry on notification', async () => {
        let callCount = 0;
        cliManager.ensureProcess.callsFake(() => {
            callCount++;
            if (callCount === 1) {
                return Promise.reject(new Error('Connection refused'));
            }
            // Second call succeeds
            return Promise.resolve(fakeProcess());
        });

        // First call: user clicks "Retry"
        showErrorMessageStub.onFirstCall().resolves('Retry');
        // Second call (after retry): no action needed
        showErrorMessageStub.onSecondCall().resolves(undefined);

        await provider.handleUserMessage('hello world');
        // The retry is queued from the notification callback
        await provider.whenIdle();

        assert.strictEqual(callCount, 2, 'ensureProcess should be called twice (original + retry)');
    });

    test('does not retry when user dismisses the error notification', async () => {
        cliManager.ensureProcess.rejects(new Error('Connection refused'));
        showErrorMessageStub.resolves(undefined); // User dismisses

        await provider.handleUserMessage('hello world');

        assert.ok(cliManager.ensureProcess.calledOnce, 'Should only attempt once');
    });

    test('handles retry from webview message when last failed message exists', async () => {
        // First: cause a failure to store _lastFailedMessage
        cliManager.ensureProcess.rejects(new Error('broken pipe'));
        showErrorMessageStub.resolves(undefined); // dismiss notification

        await provider.handleUserMessage('test message');

        // Now set up success for the retry
        cliManager.ensureProcess.resolves(fakeProcess());

        // Get the onDidReceiveMessage handler and simulate a retry message
        const messageHandler = fakeWebview.onDidReceiveMessage.firstCall.args[0];
        await messageHandler({ type: 'retry' });
        await provider.whenIdle();

        // ensureProcess should be called again (once for failure, once for retry)
        assert.strictEqual(cliManager.ensureProcess.callCount, 2, 'Should retry via webview message');
    });

    test('webview retry does nothing when no failed message exists', async () => {
        // No prior failure — _lastFailedMessage is null
        const messageHandler = fakeWebview.onDidReceiveMessage.firstCall.args[0];
        await messageHandler({ type: 'retry' });

        assert.ok(cliManager.ensureProcess.notCalled, 'Should not call ensureProcess when no failed message');
    });

    test('clears last failed message on successful completion', async () => {
        // First call fails
        cliManager.ensureProcess.onFirstCall().rejects(new Error('timeout'));
        showErrorMessageStub.resolves(undefined);

        await provider.handleUserMessage('my message');

        // Second call succeeds
        cliManager.ensureProcess.onSecondCall().resolves(fakeProcess());

        await provider.handleUserMessage('my message');
        assert.ok(
            fakeWebview.postMessage.getCalls().some((c: sinon.SinonSpyCall) => c.args[0]?.type === 'response' && c.args[0]?.done === true),
            'Successful prompt should finish with a done response'
        );

        // Now retry from webview should do nothing since success cleared the stored message
        cliManager.ensureProcess.resetHistory();
        const messageHandler = fakeWebview.onDidReceiveMessage.firstCall.args[0];
        await messageHandler({ type: 'retry' });

        assert.ok(cliManager.ensureProcess.notCalled, 'Should not retry after successful completion');
    });

    test('forwards error to webview in addition to showing notification', async () => {
        cliManager.ensureProcess.rejects(new Error('process crashed'));
        showErrorMessageStub.resolves(undefined);

        await provider.handleUserMessage('test');

        // Check that an error message was posted to the webview
        const errorPost = fakeWebview.postMessage.getCalls().find(
            (c: sinon.SinonSpyCall) => c.args[0]?.type === 'error'
        );
        assert.ok(errorPost, 'Should post error to webview');
        assert.ok(
            (errorPost!.args[0].message as string).includes('process crashed'),
            'Webview error should contain original message'
        );
    });

    test('retry re-sends the exact failed prompt without adding context again', async () => {
        cliManager.ensureProcess.onFirstCall().rejects(new Error('timeout'));
        const proc = fakeProcess();
        cliManager.ensureProcess.onSecondCall().resolves(proc);

        await provider.handleUserMessage('explain the build');
        const messageHandler = fakeWebview.onDidReceiveMessage.firstCall.args[0];
        messageHandler({ type: 'retry' });
        await provider.whenIdle();

        assert.strictEqual(proc.sendPrompt.callCount, 1);
        assert.ok((proc.sendPrompt.firstCall.args[0] as string).endsWith('explain the build'));
        assert.strictEqual((proc.sendPrompt.firstCall.args[0] as string).split('explain the build').length, 2, 'prompt is not doubled');
    });
});

suite('ChatPanelProvider - Message Queue', () => {
    let sandbox: sinon.SinonSandbox;
    let provider: ChatPanelProvider;
    let cliManager: sinon.SinonStubbedInstance<CliManager>;
    let posted: any[];
    let messageHandler: (m: unknown) => void;
    /** Resolvers for prompts currently "running" in the fake CLI, in order. */
    let finishPrompt: Array<(ok: boolean) => void>;
    let proc: any;

    /** Lets queued promise callbacks run. */
    const flush = () => new Promise<void>((r) => setImmediate(r));
    const postedOfType = (type: string) => posted.filter((m) => m?.type === type);

    setup(() => {
        sandbox = sinon.createSandbox();
        posted = [];
        finishPrompt = [];

        proc = {
            configOptions: [],
            sessionId: 'fake-session',
            // Advertised by the "agent", so these slash messages are sent as typed
            // (and without editor context), like any prompt
            availableCommands: ['first', 'second', 'm1', 'm2', 'm3', 'only', 'again'].map((name) => ({ name, description: '' })),
            sendPrompt: sandbox.stub().callsFake(() => new Promise((resolve, reject) => {
                finishPrompt.push((ok) => (ok ? resolve({ stopReason: 'end_turn' }) : reject(new Error('boom'))));
            })),
        };

        cliManager = sandbox.createStubInstance(CliManager);
        (cliManager as any).onDidChangeState = sandbox.stub().returns({ dispose: () => undefined });
        Object.defineProperty(cliManager, 'state', { value: { status: 'ready', cliPath: 'kiro-cli' } });
        cliManager.ensureProcess.resolves(proc);
        cliManager.newSession.resolves(proc);

        sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        sandbox.stub(require('fs'), 'readFileSync').returns('<html></html>');

        const webview = {
            postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true); },
            html: '',
            onDidReceiveMessage: (handler: (m: unknown) => void) => { messageHandler = handler; return { dispose: () => undefined }; },
            cspSource: '',
            asWebviewUri: () => vscode.Uri.parse('https://fake'),
        };
        sandbox.stub(vscode.window, 'createWebviewPanel').returns({
            webview,
            reveal: sandbox.stub(),
            onDidDispose: sandbox.stub(),
            onDidChangeViewState: sandbox.stub(),
            dispose: sandbox.stub(),
        } as any);

        provider = new ChatPanelProvider(vscode.Uri.file('/fake/extension'), cliManager as unknown as CliManager);
        provider.openPanel();
    });

    teardown(() => {
        provider.dispose();
        sandbox.restore();
    });

    test('a message sent while Kiro is working waits for the current turn', async () => {
        messageHandler({ type: 'sendMessage', text: '/first', id: 'msg-1' });
        await flush();
        messageHandler({ type: 'sendMessage', text: '/second', id: 'msg-2' });
        await flush();

        assert.strictEqual(proc.sendPrompt.callCount, 1, 'second prompt must not start while the first runs');
        assert.deepStrictEqual(postedOfType('messageQueued'), [{ type: 'messageQueued', id: 'msg-2' }]);

        finishPrompt[0](true);
        await flush();
        assert.strictEqual(proc.sendPrompt.callCount, 2, 'second prompt starts after the first finishes');
        assert.strictEqual(proc.sendPrompt.secondCall.args[0], '/second');
        assert.deepStrictEqual(postedOfType('messageDequeued'), [{ type: 'messageDequeued', id: 'msg-2' }]);

        finishPrompt[1](true);
        await provider.whenIdle();
    });

    test('queued messages are sent in order', async () => {
        for (const n of [1, 2, 3]) {
            messageHandler({ type: 'sendMessage', text: `/m${n}`, id: `msg-${n}` });
        }
        for (let i = 0; i < 3; i++) {
            await flush();
            finishPrompt[i](true);
        }
        await provider.whenIdle();

        assert.deepStrictEqual(proc.sendPrompt.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]), ['/m1', '/m2', '/m3']);
    });

    test('a message sent when idle is not marked as queued', async () => {
        messageHandler({ type: 'sendMessage', text: '/only', id: 'msg-1' });
        await flush();
        finishPrompt[0](true);
        await provider.whenIdle();

        assert.strictEqual(postedOfType('messageQueued').length, 0);
    });

    test('clearing the chat discards queued messages', async () => {
        messageHandler({ type: 'sendMessage', text: '/first', id: 'msg-1' });
        messageHandler({ type: 'sendMessage', text: '/second', id: 'msg-2' });
        await flush();

        messageHandler({ type: 'clearChat' });
        finishPrompt[0](true);
        await provider.whenIdle();

        assert.strictEqual(proc.sendPrompt.callCount, 1, 'queued message must not be sent after clearing');
        assert.deepStrictEqual(postedOfType('messageDropped'), [{ type: 'messageDropped', id: 'msg-2' }]);
    });

    test('a failed turn discards queued messages and says so', async () => {
        messageHandler({ type: 'sendMessage', text: '/first', id: 'msg-1' });
        messageHandler({ type: 'sendMessage', text: '/second', id: 'msg-2' });
        await flush();

        finishPrompt[0](false);
        await provider.whenIdle();

        assert.strictEqual(proc.sendPrompt.callCount, 1);
        assert.deepStrictEqual(postedOfType('messageDropped'), [{ type: 'messageDropped', id: 'msg-2' }]);
        assert.ok(
            postedOfType('systemMessage').some((m) => /1 queued message was not sent/.test(m.message)),
            'user is told the queued message was not sent'
        );
    });

    test('Retry on the error notification still sends while queued messages are discarded', async () => {
        (vscode.window.showErrorMessage as sinon.SinonStub).onFirstCall().resolves('Retry' as any);
        messageHandler({ type: 'sendMessage', text: '/first', id: 'msg-1' });
        messageHandler({ type: 'sendMessage', text: '/second', id: 'msg-2' });
        await flush();

        finishPrompt[0](false);
        await flush();
        await flush();
        assert.deepStrictEqual(proc.sendPrompt.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]), ['/first', '/first'],
            'the retried prompt is sent; the queued one is not');
        finishPrompt[1](true);
        await provider.whenIdle();
        assert.deepStrictEqual(postedOfType('messageDropped'), [{ type: 'messageDropped', id: 'msg-2' }]);
    });

    test('the working directory locks on the first message and unlocks when the chat is cleared', async () => {
        assert.strictEqual(provider.isWorkingDirectoryLocked, false);
        messageHandler({ type: 'sendMessage', text: '/first', id: 'msg-1' });
        await flush();
        assert.strictEqual(provider.isWorkingDirectoryLocked, true);
        assert.strictEqual(postedOfType('sessionInfo').pop()?.info.locked, true, 'header shows the lock');

        finishPrompt[0](true);
        await provider.whenIdle();
        assert.strictEqual(provider.isWorkingDirectoryLocked, true, 'stays locked between turns');

        messageHandler({ type: 'clearChat' });
        await flush();
        assert.strictEqual(provider.isWorkingDirectoryLocked, false);
        assert.strictEqual(postedOfType('sessionInfo').pop()?.info.locked, false);
    });

    test('the queue keeps working after a failed turn', async () => {
        messageHandler({ type: 'sendMessage', text: '/first', id: 'msg-1' });
        await flush();
        finishPrompt[0](false);
        await provider.whenIdle();

        messageHandler({ type: 'sendMessage', text: '/again', id: 'msg-2' });
        await flush();
        assert.strictEqual(proc.sendPrompt.callCount, 2);
        finishPrompt[1](true);
        await provider.whenIdle();
    });
});
