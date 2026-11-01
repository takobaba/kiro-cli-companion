/**
 * SpecWorkflowManager orchestrates the Spec workflow phases through the CLI.
 *
 * Manages the fixed phase order (requirements → design → tasks), communicates
 * with the CLI via ACP, sends specPhaseBar messages to the Chat Panel for UI
 * updates, persists spec artifacts to disk, and handles input dialogs for
 * spec name/description with collision detection and backup.
 */

import * as vscode from 'vscode';
import { CliManager } from '../cli/cliManager';
import { ChatPanelProvider } from '../chat/chatPanelProvider';
import type { SpecPhase } from '../types';

/** Fixed phase ordering for the Spec workflow. */
const PHASE_ORDER: SpecPhase[] = ['requirements', 'design', 'tasks'];

/** File names for each phase artifact. */
const PHASE_FILES: Record<SpecPhase, string> = {
    requirements: 'requirements.md',
    design: 'design.md',
    tasks: 'tasks.md',
};

/** Phase prompts include this instruction to prevent file creation. */
const SAVE_NOTICE = (specName: string, phase: SpecPhase) =>
    `\n\nIMPORTANT: Do NOT create or write any files. Just output the document content ` +
    `directly in this chat as Markdown. I will save it to .kiro/specs/${specName}/${PHASE_FILES[phase]} myself.`;

/** Plain-language step announcements shown in the chat. */
const STEP_LABEL: Record<SpecPhase, string> = {
    requirements: 'Step 1 of 3 — Requirements: what the feature must do.',
    design: 'Step 2 of 3 — Design: how to build it, based on the requirements.',
    tasks: 'Step 3 of 3 — Tasks: a step-by-step checklist, based on the design.',
};

export class SpecWorkflowManager {
    private _currentPhase: SpecPhase | null = null;
    private _specName: string = '';
    private _specDescription: string = '';

    /** Accumulated response content per phase. */
    private _phaseContent: Map<SpecPhase, string> = new Map();

    /** Buffer for the current phase's streaming content. */
    private _currentPhaseBuffer: string = '';

    constructor(
        private readonly _cliManager: CliManager,
        private readonly _chatPanelProvider: ChatPanelProvider
    ) { }

    /**
     * Root under which `.kiro/specs` is written: the directory kiro-cli runs in,
     * so specs live next to the steering files the CLI reads. Null when no
     * workspace folder is open.
     */
    private _specRoot(): vscode.Uri | null {
        if (!vscode.workspace.workspaceFolders?.length) {
            return null;
        }
        return vscode.Uri.file(this._cliManager.currentWorkingDirectory);
    }

    /** Returns true if a spec workflow is in progress. */
    get isActive(): boolean {
        return this._currentPhase !== null;
    }

    /** Returns the spec name for the current workflow. */
    get specName(): string {
        return this._specName;
    }

    /**
     * Starts a new Spec workflow by showing input dialogs for name and
     * description, checking for existing specs, and initiating the first phase.
     */
    async startWorkflow(): Promise<void> {
        // Step 1: Ask for spec name
        const name = await vscode.window.showInputBox({
            title: 'Plan a Feature (1/2): Name it',
            prompt: 'Kiro will write a requirements doc, a design and a task list for this feature, step by step. ' +
                'This name becomes the folder .kiro/specs/<name>/.',
            placeHolder: 'e.g. user-login',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || !value.trim()) {
                    return 'A name is required';
                }
                if (!/^[a-zA-Z0-9_-]+$/.test(value.trim())) {
                    return 'Use letters, numbers, hyphens and underscores only (no spaces)';
                }
                return undefined;
            },
        });

        if (!name) {
            return; // User cancelled
        }

        // Step 2: Ask for description
        const description = await vscode.window.showInputBox({
            title: 'Plan a Feature (2/2): Describe it',
            prompt: 'What should this feature do? A sentence or two is enough — you can refine everything afterwards.',
            placeHolder: 'e.g. Let users sign in with Google or GitHub and stay signed in for 30 days',
            ignoreFocusOut: true,
            validateInput: (value) => (value && value.trim() ? undefined : 'A short description is required'),
        });

        if (!description) {
            return; // User cancelled
        }

        this._specName = name.trim();
        this._specDescription = description?.trim() || '';

        // Step 3: Check if spec directory already exists
        const collision = await this._checkSpecCollision(this._specName);
        if (collision === 'cancel') {
            return;
        }

        // Reset state
        this._phaseContent.clear();
        this._currentPhaseBuffer = '';
        this._currentPhase = PHASE_ORDER[0];

        // Auto-open the chat panel so the user can see the workflow
        this._chatPanelProvider.openPanel();

        // Small delay to ensure the panel is ready before sending messages
        await new Promise<void>((resolve) => setTimeout(resolve, 300));

        this._notifyPhaseBar();

        this._chatPanelProvider.postMessage({
            type: 'systemMessage',
            message:
                `📋 Planning "${this._specName}" in 3 steps. Kiro writes each document here and you review it before moving on:\n` +
                `  1. Requirements — what to build\n` +
                `  2. Design — how to build it\n` +
                `  3. Tasks — a step-by-step checklist\n` +
                `Want changes? Just type them and Kiro rewrites the document. When it looks right, click "Save & Continue". ` +
                `Files are saved to .kiro/specs/${this._specName}/.`,
        });
        this._chatPanelProvider.postMessage({ type: 'systemMessage', message: STEP_LABEL.requirements });

        await this._sendPhasePrompt();
    }

    /** Resets the captured document; the reply to the next turn replaces it. */
    beginTurn(): void {
        // Keep the latest complete draft in case the next reply fails or is empty
        if (this._currentPhase && this._currentPhaseBuffer.trim()) {
            this._phaseContent.set(this._currentPhase, this._currentPhaseBuffer);
        }
        this._currentPhaseBuffer = '';
    }

    /**
     * Wraps a message typed during a spec so the reply is a complete revised
     * document for the current step (which then replaces the captured draft).
     */
    buildRevisionPrompt(userText: string): string {
        if (!this._currentPhase) {
            return userText;
        }
        const phase = this._currentPhase;
        return [
            userText,
            '',
            `(We are on the ${phase} step of the "${this._specName}" spec. Apply my feedback above and reply with the ` +
            `complete updated ${phase} document only — no commentary before or after it.)`,
            SAVE_NOTICE(this._specName, phase),
        ].join('\n');
    }

    /**
     * Captures streaming content for the current phase.
     * Called by ChatPanelProvider as response chunks arrive.
     */
    capturePhaseContent(content: string): void {
        if (!this._currentPhase) {
            return;
        }
        this._currentPhaseBuffer += content;
    }

    /**
     * Saves just the current phase's content to disk and opens it in the editor.
     * Does NOT advance to the next phase.
     */
    async saveCurrentPhase(): Promise<void> {
        if (!this._currentPhase) {
            return;
        }

        // Capture current buffer
        if (this._currentPhaseBuffer.trim()) {
            this._phaseContent.set(this._currentPhase, this._currentPhaseBuffer);
        }

        const content = this._phaseContent.get(this._currentPhase);
        if (!content) {
            this._chatPanelProvider.postMessage({
                type: 'error',
                message: 'No content to save for this phase yet.',
            });
            return;
        }

        const workspaceFolder = this._specRoot();
        if (!workspaceFolder) {
            this._chatPanelProvider.postMessage({
                type: 'error',
                message: 'No workspace folder open.',
            });
            return;
        }

        const specDir = vscode.Uri.joinPath(
            workspaceFolder, '.kiro', 'specs', this._specName
        );
        await vscode.workspace.fs.createDirectory(specDir);

        const fileName = PHASE_FILES[this._currentPhase];
        const fileUri = vscode.Uri.joinPath(specDir, fileName);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));

        this._chatPanelProvider.postMessage({
            type: 'systemMessage',
            message: `💾 Saved ${vscode.workspace.asRelativePath(fileUri)}`,
        });

        // Open the file in the editor
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch {
            // ignore
        }
    }

    /**
     * Advances to the next phase. Saves the current phase's accumulated
     * content and moves to the next phase in the workflow.
     */
    async advancePhase(): Promise<void> {
        if (!this._currentPhase) {
            return;
        }

        // Save current phase content
        if (this._currentPhaseBuffer.trim()) {
            this._phaseContent.set(this._currentPhase, this._currentPhaseBuffer);
        }
        this._currentPhaseBuffer = '';

        // Move to the next phase
        const currentIndex = PHASE_ORDER.indexOf(this._currentPhase);
        const nextIndex = currentIndex + 1;

        if (nextIndex < PHASE_ORDER.length) {
            // "Save & Continue" really saves: write this step's file now, so
            // nothing is lost if the user cancels a later step.
            const saved = await this._writePhaseFile(this._currentPhase);

            this._currentPhase = PHASE_ORDER[nextIndex];
            this._notifyPhaseBar();

            this._chatPanelProvider.postMessage({
                type: 'systemMessage',
                message: (saved ? `💾 Saved ${saved}\n` : '') + STEP_LABEL[this._currentPhase],
            });

            await this._sendPhasePrompt();
        } else {
            // All phases complete — save and finish
            await this.saveAndFinish();
        }
    }

    /**
     * Saves all accumulated phase artifacts to disk and shows file paths.
     */
    async saveAndFinish(): Promise<void> {
        // Save the last phase content if not already saved
        if (this._currentPhase && this._currentPhaseBuffer) {
            this._phaseContent.set(this._currentPhase, this._currentPhaseBuffer);
        }

        const workspaceFolder = this._specRoot();
        if (!workspaceFolder) {
            this._chatPanelProvider.postMessage({
                type: 'error',
                message: 'No workspace folder open. Cannot save spec artifacts.',
            });
            this._resetState();
            return;
        }

        const specDir = vscode.Uri.joinPath(
            workspaceFolder, '.kiro', 'specs', this._specName
        );

        // Ensure the directory exists
        await vscode.workspace.fs.createDirectory(specDir);

        const savedFiles: string[] = [];

        for (const phase of PHASE_ORDER) {
            const content = this._phaseContent.get(phase);
            if (content) {
                const fileName = PHASE_FILES[phase];
                const fileUri = vscode.Uri.joinPath(specDir, fileName);
                const encoded = Buffer.from(content, 'utf-8');
                await vscode.workspace.fs.writeFile(fileUri, encoded);
                savedFiles.push(vscode.workspace.asRelativePath(fileUri));
            }
        }

        if (savedFiles.length > 0) {
            this._chatPanelProvider.postMessage({
                type: 'systemMessage',
                message: `✅ Spec "${this._specName}" saved to .kiro/specs/${this._specName}/\n${savedFiles.map(f => `  📄 ${f}`).join('\n')}\n` +
                    `Next: ask Kiro to "implement task 1 from the ${this._specName} spec". You'll find it under Specs in the Kiro sidebar.`,
            });

            // Open the first file for the user
            const firstFile = vscode.Uri.joinPath(specDir, PHASE_FILES[PHASE_ORDER[0]]);
            try {
                const doc = await vscode.workspace.openTextDocument(firstFile);
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch {
                // File might not exist if that phase had no content
            }
        } else {
            this._chatPanelProvider.postMessage({
                type: 'error',
                message: 'No spec content was captured. The AI response may not have been received.',
            });
        }

        this._resetState();
    }

    /**
     * Cancels the current workflow and resets all state.
     */
    cancelWorkflow(): void {
        this._chatPanelProvider.postMessage({
            type: 'systemMessage',
            message: 'Spec workflow cancelled.',
        });
        this._resetState();
    }

    /**
     * Checks if a spec directory already exists and prompts the user.
     */
    private async _checkSpecCollision(specName: string): Promise<'overwrite' | 'rename' | 'cancel'> {
        const workspaceFolder = this._specRoot();
        if (!workspaceFolder) {
            return 'overwrite';
        }

        const specDir = vscode.Uri.joinPath(
            workspaceFolder, '.kiro', 'specs', specName
        );

        try {
            await vscode.workspace.fs.stat(specDir);
        } catch {
            return 'overwrite'; // Directory doesn't exist
        }

        const choice = await vscode.window.showWarningMessage(
            `Spec "${specName}" already exists. What would you like to do?`,
            { modal: true },
            'Overwrite (backup existing)',
            'Rename',
            'Cancel'
        );

        if (choice === 'Overwrite (backup existing)') {
            await this._backupExistingSpec(specDir);
            return 'overwrite';
        } else if (choice === 'Rename') {
            const newName = await vscode.window.showInputBox({
                title: 'New Spec Name',
                prompt: 'Enter a new name for the spec',
                value: `${specName}-2`,
                validateInput: (value) => {
                    if (!value || !value.trim()) {
                        return 'Spec name is required';
                    }
                    if (!/^[a-zA-Z0-9_-]+$/.test(value.trim())) {
                        return 'Only letters, numbers, hyphens, and underscores';
                    }
                    return undefined;
                },
            });

            if (!newName) {
                return 'cancel';
            }

            this._specName = newName.trim();
            return this._checkSpecCollision(this._specName);
        }

        return 'cancel';
    }

    /**
     * Backs up existing spec files by renaming them with .bak extension.
     */
    private async _backupExistingSpec(specDir: vscode.Uri): Promise<void> {
        for (const phase of PHASE_ORDER) {
            const fileName = PHASE_FILES[phase];
            const fileUri = vscode.Uri.joinPath(specDir, fileName);
            const bakUri = vscode.Uri.joinPath(specDir, `${fileName}.bak`);

            try {
                await vscode.workspace.fs.stat(fileUri);
                await vscode.workspace.fs.rename(fileUri, bakUri, { overwrite: true });
            } catch {
                // File doesn't exist, skip
            }
        }
    }

    /**
     * Builds the phase prompt and sends it via the chat panel's spec prompt handler
     * (which does NOT prepend editor context).
     */
    private async _sendPhasePrompt(): Promise<void> {
        if (!this._currentPhase) {
            return;
        }

        const prompt = this._buildPhasePrompt(this._currentPhase);
        await this._chatPanelProvider.handleSpecPrompt(prompt, this._currentPhase);
    }

    /**
     * Builds a detailed prompt for each phase, matching the PyCharm plugin's approach.
     * Each prompt explicitly tells the AI not to create files.
     */
    private _buildPhasePrompt(phase: SpecPhase): string {
        const notice = SAVE_NOTICE(this._specName, phase);

        switch (phase) {
            case 'requirements':
                return [
                    `I'm starting a spec workflow for a feature called "${this._specName}".`,
                    this._specDescription ? `\nDescription: ${this._specDescription}` : '',
                    '\nPlease generate the **requirements** document for this feature. Include:',
                    '- A clear summary of what the feature does',
                    '- User stories (As a [role], I want [goal], so that [benefit])',
                    '- Acceptance criteria',
                    '- Constraints and assumptions',
                    notice,
                ].filter(Boolean).join('\n');

            case 'design':
                return [
                    `Now generate the **design** document for "${this._specName}" based on the requirements above. Include:`,
                    '- Architecture overview',
                    '- Key components and their responsibilities',
                    '- Data models / types',
                    '- API contracts or interfaces',
                    '- Error handling strategy',
                    notice,
                ].join('\n');

            case 'tasks':
                return [
                    `Now generate the **implementation tasks** for "${this._specName}" based on the requirements and design above. Include:`,
                    '- Numbered task list with clear deliverables',
                    '- Each task should be small enough to implement in one sitting',
                    '- Include file paths where changes are needed',
                    '- Mark dependencies between tasks',
                    notice,
                ].join('\n');
        }
    }

    /**
     * Writes one phase's captured document to .kiro/specs/<name>/.
     * Returns the workspace-relative path, or null if there was nothing to save.
     */
    private async _writePhaseFile(phase: SpecPhase): Promise<string | null> {
        const content = this._phaseContent.get(phase);
        const root = this._specRoot();
        if (!content || !root) {
            return null;
        }
        const specDir = vscode.Uri.joinPath(root, '.kiro', 'specs', this._specName);
        await vscode.workspace.fs.createDirectory(specDir);
        const fileUri = vscode.Uri.joinPath(specDir, PHASE_FILES[phase]);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
        return vscode.workspace.asRelativePath(fileUri);
    }

    /**
     * Sends a specPhaseBar message to the Chat Panel.
     */
    private _notifyPhaseBar(): void {
        if (!this._currentPhase) {
            return;
        }

        const phaseIndex = PHASE_ORDER.indexOf(this._currentPhase);
        this._chatPanelProvider.postMessage({
            type: 'specPhaseBar',
            phase: this._currentPhase,
            phaseIndex,
            phases: [...PHASE_ORDER],
        });
    }

    /**
     * Resets all workflow state and hides the phase bar.
     */
    private _resetState(): void {
        this._currentPhase = null;
        this._specName = '';
        this._specDescription = '';
        this._phaseContent.clear();
        this._currentPhaseBuffer = '';

        this._chatPanelProvider.postMessage({
            type: 'specPhaseBar',
            phase: 'requirements',
            phaseIndex: -1,
            phases: [],
        });
    }
}
