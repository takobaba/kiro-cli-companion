/**
 * Kiro Chat Panel — Webview main script.
 *
 * Handles message exchange with the extension host via postMessage,
 * renders markdown content with syntax-highlighted code blocks and copy buttons,
 * manages model selection, tool status display, system messages, and chat UI state.
 */

(function () {
    // @ts-ignore — acquireVsCodeApi is injected by the VS Code webview runtime
    const vscode = acquireVsCodeApi();

    // ---- DOM References ----
    const messagesEl = document.getElementById('messages');
    const loadingEl = document.getElementById('loading-indicator');
    const specPhaseBar = document.getElementById('spec-phase-bar');
    const inputEl = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-btn');
    const modelSelector = document.getElementById('model-selector');
    const clearChatBtn = document.getElementById('clear-chat-btn');
    const contextRing = document.getElementById('context-ring');
    const contextUsageEl = document.getElementById('context-usage');
    const modeSelector = document.getElementById('mode-selector');
    const cwdIndicator = document.getElementById('cwd-indicator');
    const cwdPathEl = document.getElementById('cwd-path');
    const cwdStatusEl = document.getElementById('cwd-status');
    const queuedEl = document.getElementById('queued-messages');

    /** @type {number} Counter for user message IDs (used to track queued bubbles) */
    let nextMessageId = 0;

    /** @type {HTMLDivElement|null} Current assistant message element being streamed into */
    let currentAssistantMsg = null;
    /** @type {string} Accumulated content for the current streaming response */
    let streamBuffer = '';
    /** @type {Object<string, string>} Maps a <select> id to the config option ID it controls */
    let selectorConfigIds = {};
    /** @type {boolean} Guard to prevent selector change events during programmatic updates */
    let updatingSelectors = false;

    // Models and agents are populated from kiro-cli's session data, not
    // hardcoded — so new models show up without an extension update.

    // ---- Outgoing Messages ----

    /**
     * Sends a user message to the extension host.
     */
    function sendMessage() {
        var text = inputEl.value.trim();
        if (!text) {
            return;
        }
        var id = 'msg-' + (++nextMessageId);
        appendUserMessage(text, id);
        vscode.postMessage({ type: 'sendMessage', text: text, id: id });
        inputEl.value = '';
        autoResizeInput();
    }

    /**
     * Sends a retry request to the extension host.
     */
    function sendRetry() {
        vscode.postMessage({ type: 'retry' });
    }

    /** True while Kiro is working on a turn (the Stop button is visible). */
    var isWorking = false;

    /**
     * Asks the extension host to stop the running turn.
     */
    function sendStop() {
        if (!isWorking) {
            return;
        }
        vscode.postMessage({ type: 'stop' });
    }

    if (stopBtn) {
        stopBtn.addEventListener('click', sendStop);
    }

    // ---- Clear Chat Button ----
    if (clearChatBtn) {
        clearChatBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'clearChat' });
        });
    }

    // ---- Start Spec Button ----
    var startSpecBtn = document.getElementById('start-spec-btn');
    if (startSpecBtn) {
        startSpecBtn.addEventListener('click', function () {
            vscode.postMessage({ type: 'startSpec' });
        });
    }

    // ---- Incoming Messages ----

    window.addEventListener('message', function (event) {
        var msg = event.data;
        switch (msg.type) {
            case 'response':
                handleResponse(msg.content, msg.done);
                break;
            case 'toolStatus':
                handleToolStatus(msg.title, msg.status, msg.kind, msg.toolCallId);
                break;
            case 'error':
                handleError(msg.message);
                break;
            case 'loading':
                handleLoading(msg.active);
                break;
            case 'specPhaseBar':
                handleSpecPhaseBar(msg.phase, msg.phaseIndex, msg.phases);
                break;
            case 'systemMessage':
                handleSystemMessage(msg.message);
                break;
            case 'configOptions':
                handleConfigOptions(msg.options);
                break;
            case 'clearChat':
                handleClearChat();
                break;
            case 'contextUsage':
                handleContextUsage(msg.usage);
                break;
            case 'sessionInfo':
                handleSessionInfo(msg.info);
                break;
            case 'messageQueued':
                handleMessageQueued(msg.id);
                break;
            case 'messageDequeued':
                handleMessageDequeued(msg.id);
                break;
            case 'messageDropped':
                handleMessageDropped(msg.id);
                break;
            case 'permissionRequest':
                handlePermissionRequest(msg.request);
                break;
            case 'permissionResolved':
                handlePermissionResolved(msg.requestId, msg.label);
                break;
        }
    });

    // ---- Tool Permissions ----
    // kiro-cli asks before running tools its rules don't allow. Only the
    // options it offered are shown. "Always" choices are saved as a rule in
    // the scope picked here (workspace, all projects, or this session).

    var SCOPE_LABELS = { workspace: 'this workspace', user: 'all projects', session: 'this session' };
    var CAPABILITY_LABELS = {
        shell: 'run a command', fs_write: 'write files', fs_read: 'read files', web_fetch: 'fetch a web page',
        web_search: 'search the web', mcp: 'use an MCP tool', subagent: 'start a sub-agent'
    };

    /**
     * @param {{requestId: string, title: string, capability?: string, resource?: string,
     *          options: Array<{optionId: string, name: string, kind: string}>, scopes: string[]}} request
     */
    function handlePermissionRequest(request) {
        // Finish the text streamed so far so the card appears after it
        if (currentAssistantMsg && streamBuffer) {
            currentAssistantMsg.innerHTML = renderMarkdown(streamBuffer);
            addCopyButtons(currentAssistantMsg);
        }
        currentAssistantMsg = null;
        streamBuffer = '';

        var card = document.createElement('div');
        card.className = 'permission-card';
        card.setAttribute('data-request-id', request.requestId);
        card.setAttribute('role', 'group');
        card.setAttribute('aria-label', 'Permission request');

        var heading = document.createElement('div');
        heading.className = 'permission-heading';
        var action = request.capability && CAPABILITY_LABELS[request.capability];
        heading.textContent = 'Kiro wants to ' + (action || ('use ' + (request.capability || 'a tool')));
        card.appendChild(heading);

        var detail = document.createElement('code');
        detail.className = 'permission-resource';
        detail.textContent = request.resource || request.title;
        card.appendChild(detail);

        var hasAlways = request.options.some(function (o) { return o.kind === 'allow_always' || o.kind === 'reject_always'; });
        var scopeSelect = null;
        if (hasAlways && request.scopes && request.scopes.length) {
            var scopeRow = document.createElement('label');
            scopeRow.className = 'permission-scope';
            scopeRow.textContent = '"Always" applies to ';
            scopeSelect = document.createElement('select');
            scopeSelect.setAttribute('aria-label', 'Where to save an always choice');
            request.scopes.forEach(function (s) {
                var opt = document.createElement('option');
                opt.value = s;
                opt.textContent = SCOPE_LABELS[s] || s;
                scopeSelect.appendChild(opt);
            });
            scopeRow.appendChild(scopeSelect);
            card.appendChild(scopeRow);
        }

        var buttons = document.createElement('div');
        buttons.className = 'permission-actions';
        request.options.forEach(function (option) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = option.name;
            btn.className = 'permission-btn ' + (option.kind.indexOf('allow') === 0 ? 'allow' : 'reject');
            btn.addEventListener('click', function () {
                var isAlways = option.kind === 'allow_always' || option.kind === 'reject_always';
                buttons.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
                if (scopeSelect) { scopeSelect.disabled = true; }
                vscode.postMessage({
                    type: 'permissionResponse',
                    requestId: request.requestId,
                    optionId: option.optionId,
                    scope: isAlways && scopeSelect ? scopeSelect.value : undefined
                });
            });
            buttons.appendChild(btn);
        });
        card.appendChild(buttons);

        messagesEl.appendChild(card);
        scrollToBottom();
        var first = buttons.querySelector('button');
        if (first) { first.focus(); }
    }

    /** @param {string} requestId @param {string} label */
    function handlePermissionResolved(requestId, label) {
        var card = document.querySelector('.permission-card[data-request-id="' + requestId + '"]');
        if (!card) {
            return;
        }
        card.classList.add('resolved');
        var actions = card.querySelector('.permission-actions');
        if (actions) { actions.remove(); }
        var scope = card.querySelector('.permission-scope');
        if (scope) { scope.remove(); }
        var result = document.createElement('div');
        result.className = 'permission-result';
        result.textContent = label;
        card.appendChild(result);
    }

    // ---- Message Queue ----
    // Like kiro-cli, messages sent while Kiro is working wait for the current
    // turn. They sit above the input until sent, then join the transcript.

    /** @param {string} id */
    function findUserMessage(id) {
        return document.querySelector('.message.user[data-msg-id="' + id + '"]');
    }

    /** @param {HTMLElement} el @param {string|null} text */
    function setMessageNote(el, text) {
        var note = el.querySelector('.message-note');
        if (!text) {
            if (note) { note.remove(); }
            return;
        }
        if (!note) {
            note = document.createElement('span');
            note.className = 'message-note';
            el.appendChild(note);
        }
        note.textContent = text;
    }

    function updateQueueVisibility() {
        if (queuedEl) {
            queuedEl.classList.toggle('hidden', queuedEl.children.length === 0);
        }
    }

    /** @param {string} id */
    function handleMessageQueued(id) {
        var el = findUserMessage(id);
        if (!el || !queuedEl) {
            return;
        }
        el.classList.add('queued');
        setMessageNote(el, 'Queued — sends when Kiro finishes');
        queuedEl.appendChild(el);
        updateQueueVisibility();
    }

    /** @param {string} id */
    function handleMessageDequeued(id) {
        var el = findUserMessage(id);
        if (!el) {
            return;
        }
        el.classList.remove('queued');
        setMessageNote(el, null);
        messagesEl.appendChild(el);
        updateQueueVisibility();
        scrollToBottom();
    }

    /** @param {string} id */
    function handleMessageDropped(id) {
        var el = findUserMessage(id);
        if (!el) {
            return;
        }
        el.classList.remove('queued');
        el.classList.add('not-sent');
        setMessageNote(el, 'Not sent');
        messagesEl.appendChild(el);
        updateQueueVisibility();
        scrollToBottom();
    }

    // ---- Working Directory Indicator ----
    /** True once the conversation started: the folder is fixed until the chat is cleared. */
    var cwdLocked = false;
    var cwdChangeEl = document.getElementById('cwd-change');
    if (cwdIndicator) {
        cwdIndicator.addEventListener('click', function () {
            if (cwdLocked) {
                return;
            }
            vscode.postMessage({ type: 'changeWorkingDirectory' });
        });
    }

    /**
     * Shows which directory kiro-cli runs in and how it was started.
     * @param {{cwd: string, cwdSource: string, cliPath: string|null, cliSource: string|null,
     *          running: boolean, sessionId: string|null, multiRoot: boolean, locked?: boolean}} info
     */
    function handleSessionInfo(info) {
        if (!cwdIndicator || !cwdPathEl || !cwdStatusEl) {
            return;
        }
        cwdLocked = !!info.locked;
        cwdPathEl.textContent = info.cwd;
        cwdStatusEl.className = 'cwd-status' + (info.running ? ' running' : '');
        cwdIndicator.classList.toggle('locked', cwdLocked);
        cwdIndicator.setAttribute('aria-disabled', cwdLocked ? 'true' : 'false');
        if (cwdChangeEl) {
            cwdChangeEl.textContent = cwdLocked ? '🔒' : 'Change';
        }
        var lines = [
            'kiro-cli working directory: ' + info.cwd,
            'Chosen from: ' + info.cwdSource,
            'Status: ' + (info.running ? 'running (session ' + (info.sessionId || '?') + ')' : 'not started — starts with your first message'),
            'CLI: ' + (info.cliPath ? info.cliPath + ' (found via ' + (info.cliSource || 'unknown') + ')' : 'not found'),
            'Command: kiro-cli acp --agent-engine=v3',
            '',
            'kiro-cli reads .kiro/ (steering, specs, agents) and runs tools relative to this directory.',
            cwdLocked
                ? 'Fixed for this conversation. Clear the chat (🗑) to start a new one in another folder.'
                : 'Click to change' + (info.multiRoot ? ' (multi-root workspace)' : '') + '. It is fixed once you send a message.'
        ];
        cwdIndicator.title = lines.join('\n');
    }

    // ---- Message Handlers ----

    /**
     * Handles a streaming response chunk from the extension host.
     * Appends content to the current assistant message, or creates one.
     * When done=true, finalizes the message with copy buttons on code blocks.
     * @param {string} content
     * @param {boolean} done
     */
    function handleResponse(content, done) {
        if (!currentAssistantMsg) {
            currentAssistantMsg = createMessageEl('assistant');
            streamBuffer = '';
        }

        streamBuffer += content;

        // Render accumulated markdown
        currentAssistantMsg.innerHTML = renderMarkdown(streamBuffer);

        if (done) {
            // Add copy buttons to code blocks
            addCopyButtons(currentAssistantMsg);
            currentAssistantMsg = null;
            streamBuffer = '';
        }

        scrollToBottom();
    }

    /**
     * Handles a tool status update from the extension host. Tool calls are
     * not rendered; this only keeps the surrounding text readable.
     * @param {string} title
     * @param {string} status
     * @param {string} kind
     * @param {string} [toolCallId] Same ID for a call and its updates
     */
    function handleToolStatus(title, status, kind, toolCallId) {
        // Tool activity (reading, searching, …) isn't shown; the "Thinking"
        // indicator covers the whole turn. A new tool call only starts a new
        // paragraph, so text streamed before and after it doesn't run together.
        if (!title || status === 'completed' || status === 'failed') {
            return;
        }
        if (currentAssistantMsg && streamBuffer && !/\n\n$/.test(streamBuffer)) {
            streamBuffer += '\n\n';
        }
    }

    /**
     * Displays an error message with a red label and retry button.
     * @param {string} message
     */
    function handleError(message) {
        // Finalize any in-progress assistant message
        if (currentAssistantMsg && streamBuffer) {
            currentAssistantMsg.innerHTML = renderMarkdown(streamBuffer);
            addCopyButtons(currentAssistantMsg);
        }
        currentAssistantMsg = null;
        streamBuffer = '';

        var el = createMessageEl('error');
        el.innerHTML =
            '<span class="error-label">Error:</span> ' +
            escapeHtml(message) +
            '<br><button class="error-retry-btn">Retry</button>';

        var retryBtn = el.querySelector('.error-retry-btn');
        if (retryBtn) {
            retryBtn.addEventListener('click', sendRetry);
        }

        scrollToBottom();
    }

    /**
     * Shows or hides the animated loading indicator.
     * @param {boolean} active
     */
    function handleLoading(active) {
        isWorking = !!active;
        if (stopBtn) {
            stopBtn.classList.toggle('hidden', !active);
        }
        if (loadingEl) {
            if (active) {
                loadingEl.classList.remove('hidden');
            } else {
                loadingEl.classList.add('hidden');
            }
        }
        scrollToBottom();
    }

    /**
     * Renders the interactive spec phase bar with badges and action buttons.
     * Green badge for completed phases, blue for current, grey for future.
     * @param {string} phase - Current phase name
     * @param {number} phaseIndex - Current phase index
     * @param {string[]} phases - All phase names
     */
    function handleSpecPhaseBar(phase, phaseIndex, phases) {
        if (!specPhaseBar) {
            return;
        }

        // Hide if no phases (workflow ended)
        if (!phases || phases.length === 0 || phaseIndex < 0) {
            specPhaseBar.classList.add('hidden');
            specPhaseBar.innerHTML = '';
            return;
        }

        specPhaseBar.classList.remove('hidden');

        var isLastPhase = phaseIndex === phases.length - 1;

        // Build phase badges ("1 Requirements", "2 Design", "3 Tasks")
        var badgesHtml = '<div class="spec-phases-list">';
        for (var i = 0; i < phases.length; i++) {
            var badgeClass = 'spec-phase';
            if (i < phaseIndex) {
                badgeClass += ' completed';
            } else if (i === phaseIndex) {
                badgeClass += ' active';
            } else {
                badgeClass += ' future';
            }
            var label = phases[i].charAt(0).toUpperCase() + phases[i].slice(1);
            badgesHtml += '<span class="' + badgeClass + '">' + (i < phaseIndex ? '✓ ' : (i + 1) + ' ') + escapeHtml(label) + '</span>';
        }
        badgesHtml += '<span class="spec-phase-description">Step ' + (phaseIndex + 1) + ' of ' + phases.length + '</span>';
        badgesHtml += '</div>';
        badgesHtml += '<div class="spec-phase-hint">Review the document above. Want changes? Type them below and Kiro rewrites it. ' +
            (isLastPhase ? 'When it looks right, click Save &amp; Finish.' : 'When it looks right, click Save &amp; Continue.') + '</div>';

        // Build action buttons: Save | Save & Continue (or Save & Finish) | Cancel
        var actionsHtml = '<div class="spec-phase-actions">';
        actionsHtml += '<button class="spec-save-only-btn" id="spec-save-only-btn" title="Save this document without moving on">💾 Save</button>';
        if (isLastPhase) {
            actionsHtml += '<button class="spec-accept-btn" id="spec-accept-btn">✅ Save &amp; Finish</button>';
        } else {
            actionsHtml += '<button class="spec-accept-btn" id="spec-accept-btn">✅ Save &amp; Continue →</button>';
        }
        actionsHtml += '<button class="spec-cancel-btn" id="spec-cancel-btn">✕ Cancel</button>';
        actionsHtml += '</div>';

        specPhaseBar.innerHTML = badgesHtml + actionsHtml;

        // Wire up button events
        var saveOnlyBtn = document.getElementById('spec-save-only-btn');
        var acceptBtn = document.getElementById('spec-accept-btn');
        var cancelBtn = document.getElementById('spec-cancel-btn');

        if (saveOnlyBtn) {
            saveOnlyBtn.addEventListener('click', function () {
                vscode.postMessage({ type: 'specSave' });
            });
        }
        if (acceptBtn) {
            acceptBtn.addEventListener('click', function () {
                vscode.postMessage({ type: 'specAccept' });
            });
        }
        if (cancelBtn) {
            cancelBtn.addEventListener('click', function () {
                vscode.postMessage({ type: 'specCancel' });
            });
        }
    }

    /**
     * Displays a system message with muted styling.
     * @param {string} message
     */
    function handleSystemMessage(message) {
        var el = document.createElement('div');
        el.className = 'system-message';
        el.textContent = message;
        messagesEl.appendChild(el);
        scrollToBottom();
    }

    /**
     * Updates the model and agent selectors from config options.
     * @param {Array} options
     */
    function handleConfigOptions(options) {
        for (var i = 0; i < options.length; i++) {
            var option = options[i];
            if (option.category === 'model') {
                populateSelector(modelSelector, option);
            } else if (option.category === 'mode') {
                populateSelector(modeSelector, option);
            }
        }
    }

    /**
     * Fills a <select> from a config option and selects its current value.
     * @param {HTMLSelectElement|null} selectEl
     * @param {{id: string, currentValue: string, options: Array<{value: string, name: string, description: string}>}} option
     */
    function populateSelector(selectEl, option) {
        if (!selectEl) {
            return;
        }
        updatingSelectors = true;
        selectorConfigIds[selectEl.id] = option.id;
        selectEl.innerHTML = '';
        for (var j = 0; j < option.options.length; j++) {
            var opt = option.options[j];
            var optEl = document.createElement('option');
            optEl.value = opt.value;
            optEl.textContent = opt.name;
            if (opt.description) {
                optEl.title = opt.description;
            }
            selectEl.appendChild(optEl);
        }
        selectEl.value = option.currentValue;
        selectEl.disabled = false;
        if (option.options.length > 0) {
            selectEl.classList.remove('hidden');
        } else {
            selectEl.classList.add('hidden');
        }
        updatingSelectors = false;
    }

    /**
     * Clears all messages from the chat panel.
     */
    function handleClearChat() {
        messagesEl.innerHTML = '';
        if (queuedEl) {
            queuedEl.innerHTML = '';
            updateQueueVisibility();
        }
        currentAssistantMsg = null;
        streamBuffer = '';
    }

    /**
     * Updates the context usage indicator SVG ring and tooltip.
     * Color-coded: green (<50%), yellow (50-80%), red (>80%).
     * @param {{ conversation: number, mcpTools: number, steeringFiles: number, total: number }} usage
     */
    function handleContextUsage(usage) {
        if (!contextRing || !contextUsageEl) {
            return;
        }

        var total = usage.total || 0;
        var circumference = 2 * Math.PI * 7; // r=7, circumference ≈ 43.98

        // Calculate stroke-dasharray for the filled portion
        var filled = (total / 100) * circumference;
        var remaining = circumference - filled;
        contextRing.setAttribute('stroke-dasharray', filled + ' ' + remaining);

        // Color based on usage level
        var color;
        if (total < 50) {
            color = '#73c991'; // green
        } else if (total < 80) {
            color = '#cca700'; // yellow
        } else {
            color = '#f48771'; // red
        }
        contextRing.setAttribute('stroke', color);

        // Update tooltip text
        contextUsageEl.title = 'Context used: ' + Math.round(total) + '%';

        var ctxTotal = document.getElementById('ctx-total');
        if (ctxTotal) { ctxTotal.textContent = Math.round(total); }
    }

    // ---- Model / Agent Selectors ----

    /**
     * Sends a selection change for a selector to the extension host.
     * @param {HTMLSelectElement|null} selectEl
     */
    function wireSelector(selectEl) {
        if (!selectEl) {
            return;
        }
        selectEl.addEventListener('change', function () {
            if (updatingSelectors) {
                return;
            }
            var configId = selectorConfigIds[selectEl.id];
            if (!configId || !selectEl.value) {
                return;
            }
            vscode.postMessage({ type: 'selectModel', configId: configId, value: selectEl.value });
        });
    }

    wireSelector(modelSelector);
    wireSelector(modeSelector);

    // ---- DOM Helpers ----

    /**
     * Appends a user message bubble to the chat.
     * @param {string} text
     * @param {string} [id] Tracks the bubble if the message gets queued
     */
    function appendUserMessage(text, id) {
        var el = createMessageEl('user');
        el.textContent = text;
        if (id) {
            el.setAttribute('data-msg-id', id);
        }
        scrollToBottom();
    }

    /**
     * Creates a message element and appends it to the messages container.
     * @param {'user'|'assistant'|'error'} role
     * @returns {HTMLDivElement}
     */
    function createMessageEl(role) {
        var el = document.createElement('div');
        el.className = 'message ' + role;
        messagesEl.appendChild(el);
        return el;
    }

    /**
     * Adds copy-to-clipboard buttons to all code blocks in a message element.
     * @param {HTMLElement} messageEl
     */
    function addCopyButtons(messageEl) {
        var codeBlocks = messageEl.querySelectorAll('pre');
        for (var i = 0; i < codeBlocks.length; i++) {
            var pre = codeBlocks[i];
            // Skip if already has a copy button
            if (pre.querySelector('.copy-btn')) {
                continue;
            }

            var btn = document.createElement('button');
            btn.className = 'copy-btn';
            btn.textContent = '📋';
            btn.title = 'Copy to clipboard';
            btn.setAttribute('aria-label', 'Copy code to clipboard');

            // Capture the code content for the click handler
            (function (codeBlock, copyBtn) {
                copyBtn.addEventListener('click', function () {
                    var codeEl = codeBlock.querySelector('code');
                    var text = codeEl ? codeEl.textContent : codeBlock.textContent;
                    navigator.clipboard.writeText(text || '').then(function () {
                        copyBtn.textContent = '✓';
                        setTimeout(function () {
                            copyBtn.textContent = '📋';
                        }, 1500);
                    });
                });
            })(pre, btn);

            // Position the button in the code block header if present, otherwise in the pre
            var header = pre.querySelector('.code-block-header');
            if (header) {
                header.appendChild(btn);
            } else {
                pre.style.position = 'relative';
                btn.style.position = 'absolute';
                btn.style.top = '4px';
                btn.style.right = '4px';
                pre.appendChild(btn);
            }
        }
    }

    function scrollToBottom() {
        if (messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    // ---- Input Handling ----

    inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Esc anywhere in the chat stops Kiro while it's working
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && isWorking) {
            e.preventDefault();
            sendStop();
        }
    });

    inputEl.addEventListener('input', autoResizeInput);

    sendBtn.addEventListener('click', sendMessage);

    function autoResizeInput() {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    }

    // ---- Markdown Renderer (markdown.js, loaded first) ----

    var renderMarkdown = window.KiroMarkdown.renderMarkdown;
    var escapeHtml = window.KiroMarkdown.escapeHtml;

    // Tell the extension host we're listening so it can send session info
    vscode.postMessage({ type: 'ready' });
})();
