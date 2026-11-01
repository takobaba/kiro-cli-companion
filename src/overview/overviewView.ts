/**
 * "Kiro" sidebar view: shows what Kiro is working with — rules (steering),
 * specs, custom agents, skills and MCP servers — for the CLI's working
 * directory and globally. Items open their file on click.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CliManager } from '../cli/cliManager';
import { getHomeDir } from '../cli/cliLocator';
import { Rule, RuleInclusion, describeInclusion, globalRulesDir, listRulesIn, newRuleTemplate, projectRulesDir } from '../rules/rules';
import { KiroConfig, Scope, readKiroConfig } from './kiroConfig';

type GroupId = 'rules' | 'specs' | 'agents' | 'skills' | 'mcp';

interface Node {
    item: vscode.TreeItem;
    children?: () => Node[];
}

const scopeLabel = (scope: Scope) => (scope === 'project' ? 'project' : 'global');

function fileNode(label: string, filePath: string, description: string, icon: string, tooltip?: string | vscode.MarkdownString): Node {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = description;
    item.iconPath = new vscode.ThemeIcon(icon);
    item.tooltip = tooltip ?? filePath;
    item.resourceUri = vscode.Uri.file(filePath);
    item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(filePath)] };
    return { item };
}

function hintNode(label: string, tooltip: string, command?: vscode.Command): Node {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(command ? 'add' : 'info');
    item.tooltip = tooltip;
    item.command = command;
    return { item };
}

export class KiroOverviewProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private readonly _disposables: vscode.Disposable[] = [];
    private _projectWatcher: vscode.FileSystemWatcher | undefined;
    private readonly _globalWatcher: vscode.FileSystemWatcher;
    private _watchedCwd = '';
    private _refreshTimer: NodeJS.Timeout | undefined;

    constructor(private readonly _cliManager: CliManager) {
        this._globalWatcher = this._watch(path.join(getHomeDir(), '.kiro'));
        this._watchProject();
        // Project items follow the CLI's working directory
        this._disposables.push(
            _cliManager.onDidChangeState(() => {
                if (_cliManager.currentWorkingDirectory !== this._watchedCwd) {
                    this._watchProject();
                    this.refresh();
                }
            })
        );
    }

    /** Current configuration (read fresh from disk). */
    getConfig(): KiroConfig {
        return readKiroConfig(this._cliManager.currentWorkingDirectory, getHomeDir());
    }

    refresh(): void {
        // Debounce bursts of file events (e.g. saving a spec writes several files)
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
        }
        this._refreshTimer = setTimeout(() => this._onDidChangeTreeData.fire(), 150);
    }

    getTreeItem(node: Node): vscode.TreeItem {
        return node.item;
    }

    getChildren(node?: Node): Node[] {
        if (node) {
            return node.children ? node.children() : [];
        }
        const config = this.getConfig();
        return [
            this._group('rules', 'Rules', 'law', config.rules.length, () => this._ruleNodes(config)),
            this._group('specs', 'Specs', 'checklist', config.specs.length, () => this._specNodes(config)),
            this._group('agents', 'Custom Agents', 'person', config.agents.length, () =>
                config.agents.length
                    ? config.agents.map((a) => fileNode(a.name, a.filePath, scopeLabel(a.scope), 'person', a.description || a.filePath))
                    : [hintNode('None — kiro-cli uses its built-in agents', 'Custom agents are JSON files in .kiro/agents/ or ~/.kiro/agents/. Create one with "/agent create <name>" in the chat.')]
            ),
            this._group('skills', 'Skills', 'tools', config.skills.length, () =>
                config.skills.length
                    ? config.skills.map((s) => fileNode(s.name, s.filePath, scopeLabel(s.scope), 'tools', s.description || s.filePath))
                    : [hintNode('None', 'Skills are folders with a SKILL.md in .kiro/skills/ or ~/.kiro/skills/.')]
            ),
            this._group('mcp', 'MCP Servers', 'plug', config.mcpServers.length, () =>
                config.mcpServers.length
                    ? config.mcpServers.map((m) =>
                        fileNode(m.name, m.configPath, `${scopeLabel(m.scope)}${m.disabled ? ' · disabled' : ''}`, m.disabled ? 'debug-disconnect' : 'plug', `${m.detail || m.name}\n${m.configPath}`)
                    )
                    : [hintNode('None', 'MCP servers are defined in .kiro/settings/mcp.json or ~/.kiro/settings/mcp.json. Add one with "/mcp add" in the chat.')]
            ),
        ];
    }

    private _group(id: GroupId, label: string, icon: string, count: number, children: () => Node[]): Node {
        const item = new vscode.TreeItem(
            label,
            id === 'rules' || id === 'specs' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `kiro.overview.${id}`;
        item.description = String(count);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.contextValue = `kiroGroup.${id}`;
        return { item, children };
    }

    private _ruleNodes(config: KiroConfig): Node[] {
        // Always offer these — the view's title buttons only show on hover
        const add = hintNode(
            'Add a rule…',
            'Rules are Markdown files that tell Kiro your conventions (coding style, testing, architecture).',
            { command: 'kiro.newRule', title: 'Add Rule' }
        );
        const openFolder = hintNode(
            'Open rules folder…',
            'Show .kiro/steering (project) in VS Code\'s Explorer, or list the files in ~/.kiro/steering (global).',
            { command: 'kiro.openRulesFolder', title: 'Open Rules Folder' }
        );
        openFolder.item.iconPath = new vscode.ThemeIcon('folder-opened');
        if (!config.rules.length) {
            return [add, openFolder];
        }
        return [...config.rules.map((rule: Rule) =>
            fileNode(
                rule.name,
                rule.filePath,
                `${scopeLabel(rule.scope)} · ${describeInclusion(rule)}`,
                rule.inclusion === 'manual' ? 'mention' : rule.inclusion === 'fileMatch' ? 'file-code' : 'pass',
                new vscode.MarkdownString(
                    `**${rule.name}**${rule.description ? ` — ${rule.description}` : ''}\n\n${whenText(rule)}\n\n\`${rule.filePath}\``
                )
            )
        ), add, openFolder];
    }

    private _specNodes(config: KiroConfig): Node[] {
        const plan = hintNode(
            'Plan a feature…',
            'A spec is a plan Kiro writes with you before coding: requirements (what), design (how), and tasks (step-by-step). Saved to .kiro/specs/.',
            { command: 'kiro.startSpec', title: 'Plan a Feature' }
        );
        if (!config.specs.length) {
            return [plan];
        }
        const specNodes: Node[] = config.specs.map((spec) => {
            const item = new vscode.TreeItem(spec.name, vscode.TreeItemCollapsibleState.Collapsed);
            item.description = `${spec.docs.length} of 3 docs`;
            item.iconPath = new vscode.ThemeIcon(spec.docs.length === 3 ? 'pass-filled' : 'circle-large-outline');
            item.tooltip = `${spec.dir}\n\nAsk in the chat: "implement task 1 from the ${spec.name} spec"`;
            return {
                item,
                children: () =>
                    spec.docs.map((d) =>
                        fileNode(`${d.phase}.md`, d.filePath, d.phase === 'requirements' ? 'what to build' : d.phase === 'design' ? 'how to build it' : 'step-by-step', 'markdown')
                    ),
            };
        });
        return [...specNodes, plan];
    }

    /**
     * Shows a rules folder (project or global), creating it if needed.
     * Folders inside the workspace are revealed in VS Code's Explorer, which
     * works the same on every OS and in remote sessions. Folders outside the
     * workspace (e.g. ~/.kiro/steering) can't be shown there, so we list their
     * rule files instead.
     */
    async openRulesFolder(): Promise<void> {
        const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
        const projectDir = projectRulesDir(this._cliManager.currentWorkingDirectory);
        const globalDir = globalRulesDir(getHomeDir());
        let dir = globalDir;
        let scope: Scope = 'global';
        if (hasFolder) {
            const pick = await vscode.window.showQuickPick(
                [
                    { label: '$(folder) This project', description: projectDir, dir: projectDir, scope: 'project' as Scope },
                    { label: '$(globe) Global (all projects)', description: globalDir, dir: globalDir, scope: 'global' as Scope },
                ],
                { title: 'Open Rules Folder' }
            );
            if (!pick) {
                return;
            }
            dir = pick.dir;
            scope = pick.scope;
        }

        const dirUri = vscode.Uri.file(dir);
        await vscode.workspace.fs.createDirectory(dirUri);
        this.refresh();

        if (vscode.workspace.getWorkspaceFolder(dirUri)) {
            // Revealing a file inside expands the folder; otherwise select the folder itself
            const first = listRulesIn(dir, scope)[0];
            await vscode.commands.executeCommand('revealInExplorer', first ? vscode.Uri.file(first.filePath) : dirUri);
            return;
        }
        await this._pickRuleInFolder(dir, scope);
    }

    /** Quick pick of rule files in a folder that isn't part of the workspace. */
    private async _pickRuleInFolder(dir: string, scope: Scope): Promise<void> {
        type Item = vscode.QuickPickItem & { action: 'open' | 'new' | 'os'; filePath?: string };
        const rules = listRulesIn(dir, scope);
        const osName = process.platform === 'darwin' ? 'Finder' : process.platform === 'win32' ? 'File Explorer' : 'file manager';
        const items: Item[] = [
            ...rules.map((r): Item => ({
                label: `$(file) ${r.name}`,
                description: describeInclusion(r),
                action: 'open',
                filePath: r.filePath,
            })),
            { label: '$(add) New rule…', action: 'new' },
            // Opening the OS file manager only makes sense when VS Code runs locally
            ...(vscode.env.remoteName ? [] : [{ label: `$(folder-opened) Open in ${osName}`, description: dir, action: 'os' as const }]),
        ];
        const pick = await vscode.window.showQuickPick(items, {
            title: `${scope === 'global' ? 'Global rules' : 'Rules'} — ${dir}`,
            placeHolder: rules.length ? 'Pick a rule to edit' : 'No rules here yet',
        });
        if (!pick) {
            return;
        }
        if (pick.action === 'open' && pick.filePath) {
            await vscode.window.showTextDocument(vscode.Uri.file(pick.filePath), { preview: false });
        } else if (pick.action === 'new') {
            await this.createRule();
        } else if (pick.action === 'os') {
            await vscode.env.openExternal(vscode.Uri.file(dir));
        }
    }

    /** Guided creation of a new rule file. */
    async createRule(): Promise<void> {
        const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
        const projectDir = projectRulesDir(this._cliManager.currentWorkingDirectory);
        const globalDir = globalRulesDir(getHomeDir());
        const scopePick = await vscode.window.showQuickPick(
            [
                ...(hasFolder ? [{ label: '$(folder) This project', description: projectDir, scope: 'project' as Scope }] : []),
                { label: '$(globe) Global (all projects)', description: globalDir, scope: 'global' as Scope },
            ],
            { title: 'New Rule (1/3): Where should it apply?', ignoreFocusOut: true }
        );
        if (!scopePick) {
            return;
        }
        const dir = scopePick.scope === 'project' ? projectDir : globalDir;

        const name = await vscode.window.showInputBox({
            title: 'New Rule (2/3): Name',
            prompt: 'A short name, used as the file name and for #name references',
            placeHolder: 'e.g. coding-style, testing, api-conventions',
            ignoreFocusOut: true,
            validateInput: (v) => {
                const n = v.trim().replace(/\.md$/i, '');
                if (!n) {
                    return 'Name is required';
                }
                if (!/^[A-Za-z0-9][\w.-]*$/.test(n)) {
                    return 'Use letters, numbers, - _ or . (no spaces)';
                }
                if (fs.existsSync(path.join(dir, `${n}.md`))) {
                    return 'A rule with this name already exists';
                }
                return undefined;
            },
        });
        if (!name) {
            return;
        }
        const ruleName = name.trim().replace(/\.md$/i, '');

        const whenPick = await vscode.window.showQuickPick(
            [
                { label: 'Always', detail: 'Included with every message', inclusion: 'always' as RuleInclusion },
                { label: 'For matching files', detail: 'Included when the active file matches a pattern, e.g. **/*.test.ts', inclusion: 'fileMatch' as RuleInclusion },
                { label: 'Only when I ask', detail: `Included when you type #${ruleName} in the chat`, inclusion: 'manual' as RuleInclusion },
            ],
            { title: 'New Rule (3/3): When should Kiro use it?', ignoreFocusOut: true }
        );
        if (!whenPick) {
            return;
        }

        let pattern: string | undefined;
        if (whenPick.inclusion === 'fileMatch') {
            pattern = await vscode.window.showInputBox({
                title: 'File pattern',
                prompt: 'Glob relative to the project. Patterns without "/" match the file name.',
                value: '**/*.ts',
                ignoreFocusOut: true,
                validateInput: (v) => (v.trim() ? undefined : 'Pattern is required'),
            });
            if (!pattern) {
                return;
            }
        }

        const filePath = path.join(dir, `${ruleName}.md`);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
        await vscode.workspace.fs.writeFile(
            vscode.Uri.file(filePath),
            Buffer.from(newRuleTemplate(ruleName, whenPick.inclusion, pattern?.trim()), 'utf-8')
        );
        this.refresh();
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filePath), { preview: false });
        vscode.window.showInformationMessage(
            `Rule "${ruleName}" created. Edit and save it — it applies to new messages` +
            (whenPick.inclusion === 'manual' ? ` when you type #${ruleName}.` : '.')
        );
    }

    dispose(): void {
        this._projectWatcher?.dispose();
        this._globalWatcher.dispose();
        this._disposables.forEach((d) => d.dispose());
        this._onDidChangeTreeData.dispose();
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
        }
    }

    private _watch(kiroDir: string): vscode.FileSystemWatcher {
        // Watch the folder containing .kiro so creating `.kiro/` itself is noticed
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.dirname(kiroDir)), `${path.basename(kiroDir)}/{steering,specs,agents,skills,settings}/**`)
        );
        watcher.onDidCreate(() => this.refresh());
        watcher.onDidChange(() => this.refresh());
        watcher.onDidDelete(() => this.refresh());
        return watcher;
    }

    private _watchProject(): void {
        this._projectWatcher?.dispose();
        this._watchedCwd = this._cliManager.currentWorkingDirectory;
        this._projectWatcher = this._watch(path.join(this._watchedCwd, '.kiro'));
    }
}

function whenText(rule: Rule): string {
    switch (rule.inclusion) {
        case 'always':
            return 'Applied to every message.';
        case 'auto':
            return 'Loaded by kiro-cli; Kiro decides when it is relevant.';
        case 'fileMatch':
            return `Applied when the active file matches: ${rule.patterns.map((p) => `\`${p}\``).join(', ') || '(no pattern set)'}.`;
        case 'manual':
            return `Applied when you type \`#${rule.name}\` in the chat.`;
    }
}
