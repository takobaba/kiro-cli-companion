/**
 * "Plan a Feature (Spec)": asks for a name and description, then starts a
 * kiro-cli chat whose first message tells Kiro to write
 * .kiro/specs/<name>/{requirements,design,tasks}.md one step at a time,
 * waiting for the user's approval in the terminal between steps.
 *
 * kiro-cli writes the files itself; the "What Kiro Uses" sidebar picks them
 * up under Specs.
 */

import * as vscode from 'vscode';
import { CliManager } from '../cli/cliManager';
import { KiroTerminalManager } from '../terminal/kiroTerminal';

const SPEC_FILES = ['requirements.md', 'design.md', 'tasks.md'];

/** Valid spec names double as folder names. */
export const SPEC_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * The first message for kiro-cli. Kept on one line with no double quotes so
 * it survives being passed as a single command-line argument on every OS.
 */
export function buildSpecPrompt(specName: string, description: string): string {
    const dir = `.kiro/specs/${specName}`;
    const desc = description.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
    return [
        `Let's plan a feature called '${specName}' as a spec before writing any code.`,
        desc ? `Description: ${desc}.` : '',
        'Work in three steps and stop after each one so I can review it and ask for changes; only continue when I approve.',
        `Step 1: write ${dir}/requirements.md with a summary, user stories (As a role, I want goal, so that benefit), acceptance criteria, and constraints and assumptions.`,
        `Step 2: write ${dir}/design.md with the architecture, key components and their responsibilities, data models, interfaces, and error handling, based on the requirements.`,
        `Step 3: write ${dir}/tasks.md as a numbered checklist of small tasks with the files to change and the dependencies between tasks, based on the design.`,
        'Do not implement anything yet. Start with step 1 now.',
    ].filter(Boolean).join(' ');
}

export class SpecWorkflowManager {
    constructor(
        private readonly _cliManager: CliManager,
        private readonly _terminals: KiroTerminalManager
    ) { }

    /** Asks for the spec name and description, then starts kiro-cli on it. */
    async startWorkflow(): Promise<void> {
        let name = await vscode.window.showInputBox({
            title: 'Plan a Feature (1/2): Name it',
            prompt: 'Kiro will write a requirements doc, a design and a task list for this feature, step by step. ' +
                'This name becomes the folder .kiro/specs/<name>/.',
            placeHolder: 'e.g. user-login',
            ignoreFocusOut: true,
            validateInput: validateSpecName,
        });
        if (!name) {
            return;
        }

        const description = await vscode.window.showInputBox({
            title: 'Plan a Feature (2/2): Describe it',
            prompt: 'What should this feature do? A sentence or two is enough. You can refine everything in the chat.',
            placeHolder: 'e.g. Let users sign in with Google or GitHub and stay signed in for 30 days',
            ignoreFocusOut: true,
            validateInput: (value) => (value && value.trim() ? undefined : 'A short description is required'),
        });
        if (!description) {
            return;
        }

        name = await this._resolveCollision(name.trim());
        if (!name) {
            return;
        }

        await this._terminals.start({
            name: `Kiro Spec: ${name}`,
            prompt: buildSpecPrompt(name, description),
        });
    }

    /** `.kiro/specs` lives in the directory kiro-cli runs in. */
    private _specDir(specName: string): vscode.Uri {
        return vscode.Uri.joinPath(vscode.Uri.file(this._cliManager.currentWorkingDirectory), '.kiro', 'specs', specName);
    }

    /**
     * If the spec already exists, asks whether to overwrite (backing up the
     * current files) or rename. Returns the name to use, or undefined to stop.
     */
    private async _resolveCollision(specName: string): Promise<string | undefined> {
        const specDir = this._specDir(specName);
        try {
            await vscode.workspace.fs.stat(specDir);
        } catch {
            return specName; // doesn't exist yet
        }

        const choice = await vscode.window.showWarningMessage(
            `Spec "${specName}" already exists. What would you like to do?`,
            { modal: true },
            'Overwrite (backup existing)',
            'Rename'
        );
        if (choice === 'Overwrite (backup existing)') {
            await this._backupExistingSpec(specDir);
            return specName;
        }
        if (choice === 'Rename') {
            const newName = await vscode.window.showInputBox({
                title: 'New Spec Name',
                prompt: 'Enter a new name for the spec',
                value: `${specName}-2`,
                validateInput: validateSpecName,
            });
            return newName ? this._resolveCollision(newName.trim()) : undefined;
        }
        return undefined;
    }

    /** Renames existing spec files to *.bak so Kiro starts from a clean slate. */
    private async _backupExistingSpec(specDir: vscode.Uri): Promise<void> {
        for (const fileName of SPEC_FILES) {
            const fileUri = vscode.Uri.joinPath(specDir, fileName);
            try {
                await vscode.workspace.fs.stat(fileUri);
                await vscode.workspace.fs.rename(fileUri, vscode.Uri.joinPath(specDir, `${fileName}.bak`), { overwrite: true });
            } catch {
                // File doesn't exist, skip
            }
        }
    }
}

function validateSpecName(value: string): string | undefined {
    if (!value || !value.trim()) {
        return 'A name is required';
    }
    if (!SPEC_NAME_PATTERN.test(value.trim())) {
        return 'Use letters, numbers, hyphens and underscores only (no spaces)';
    }
    return undefined;
}
