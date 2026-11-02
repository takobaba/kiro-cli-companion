/**
 * Resolves the directory kiro-cli is started in (the Kiro terminal's cwd).
 *
 * Always using the first workspace folder is wrong for multi-root workspaces
 * where the folders are e.g. submodules of a monorepo. Resolution order:
 *
 *   1. `kiro.workingDirectory` setting (supports ${workspaceFolder},
 *      ${workspaceFolder:<name>}, ${workspaceFileDir}, ~ and relative paths)
 *   2. The directory the user previously picked for this workspace
 *   3. Single-folder workspace → that folder
 *   4. Multi-root workspace → ask the user (once), suggesting the
 *      .code-workspace file's directory / common parent first
 *   5. No folder open → the user's home directory
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getHomeDir } from './cliLocator';

export const WORKING_DIRECTORY_STATE_KEY = 'kiro.workingDirectory';

export type WorkingDirectorySource =
    | 'setting'
    | 'saved choice'
    | 'workspace folder'
    | 'picked'
    | 'multi-root default'
    | 'home directory';

export interface ResolvedWorkingDirectory {
    path: string;
    source: WorkingDirectorySource;
}

/**
 * Returns the deepest common ancestor directory of the given absolute paths,
 * or null if they don't share one (other than a filesystem root).
 */
export function commonAncestor(paths: string[]): string | null {
    if (paths.length === 0) {
        return null;
    }
    const caseInsensitive = process.platform === 'win32';
    const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
    const split = paths.map((p) => path.resolve(p).split(path.sep));
    const first = split[0];
    let len = first.length;
    for (const parts of split.slice(1)) {
        let i = 0;
        while (i < len && i < parts.length && norm(parts[i]) === norm(first[i])) {
            i++;
        }
        len = i;
    }
    // len <= 1 means only the drive ("C:") or POSIX root ("") is shared —
    // a filesystem root isn't a meaningful project directory.
    if (len <= 1) {
        return null;
    }
    const ancestor = first.slice(0, len).join(path.sep);
    if (ancestor === path.parse(ancestor).root) {
        return null;
    }
    return ancestor;
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function fileWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
}

/** Directory containing the saved .code-workspace file, if any. */
function workspaceFileDir(): string | null {
    const file = vscode.workspace.workspaceFile;
    if (file && file.scheme === 'file') {
        return path.dirname(file.fsPath);
    }
    return null;
}

/**
 * Expands variables in the `kiro.workingDirectory` setting and resolves
 * relative paths against the workspace file directory / first folder.
 */
export function expandWorkingDirectorySetting(raw: string): string | null {
    const folders = fileWorkspaceFolders();
    const firstFolder = folders[0]?.uri.fsPath;
    const wsFileDir = workspaceFileDir();

    let missing = false;
    let value = raw.trim()
        .replace(/\$\{workspaceFolder:([^}]+)\}/g, (_m, name: string) => {
            const folder = folders.find((f) => f.name === name);
            if (!folder) {
                missing = true;
                return '';
            }
            return folder.uri.fsPath;
        })
        .replace(/\$\{workspaceFolder\}/g, () => {
            if (!firstFolder) {
                missing = true;
                return '';
            }
            return firstFolder;
        })
        .replace(/\$\{workspaceFileDir\}/g, () => {
            if (!wsFileDir) {
                missing = true;
                return '';
            }
            return wsFileDir;
        })
        .replace(/\$\{userHome\}/g, () => getHomeDir());

    if (missing || !value) {
        return null;
    }
    if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
        value = path.join(getHomeDir(), value.slice(1));
    }
    if (!path.isAbsolute(value)) {
        const base = wsFileDir ?? firstFolder;
        if (!base) {
            return null;
        }
        value = path.join(base, value);
    }
    return path.resolve(value);
}

/** The directory we'd use for a multi-root workspace without asking. */
function multiRootDefault(): string {
    const folders = fileWorkspaceFolders();
    const wsFileDir = workspaceFileDir();
    const ancestor = commonAncestor(folders.map((f) => f.uri.fsPath));
    // Prefer the .code-workspace location when it contains the folders
    if (wsFileDir && ancestor && isInside(ancestor, wsFileDir)) {
        return wsFileDir;
    }
    return ancestor ?? folders[0].uri.fsPath;
}

function isInside(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolves the working directory without any UI.
 * Returns `needsPick: true` for multi-root workspaces with no saved choice.
 */
export function resolveWorkingDirectoryNonInteractive(
    workspaceState: vscode.Memento | undefined,
    log: (message: string) => void = () => undefined
): ResolvedWorkingDirectory & { needsPick: boolean } {
    const setting = vscode.workspace.getConfiguration('kiro').get<string>('workingDirectory', '').trim();
    if (setting) {
        const expanded = expandWorkingDirectorySetting(setting);
        if (expanded && isDirectory(expanded)) {
            return { path: expanded, source: 'setting', needsPick: false };
        }
        log(`[WorkingDirectory] kiro.workingDirectory "${setting}" did not resolve to an existing directory; ignoring.`);
    }

    const saved = workspaceState?.get<string>(WORKING_DIRECTORY_STATE_KEY);
    if (saved && isDirectory(saved)) {
        return { path: saved, source: 'saved choice', needsPick: false };
    }

    const folders = fileWorkspaceFolders();
    if (folders.length === 1) {
        return { path: folders[0].uri.fsPath, source: 'workspace folder', needsPick: false };
    }
    if (folders.length > 1) {
        return { path: multiRootDefault(), source: 'multi-root default', needsPick: true };
    }
    return { path: getHomeDir(), source: 'home directory', needsPick: false };
}

interface DirPickItem extends vscode.QuickPickItem {
    dir?: string;
    browse?: boolean;
}

/**
 * Shows a quick pick of candidate directories (workspace file dir, common
 * parent, each folder, or browse). Returns the chosen path or undefined.
 */
export async function pickWorkingDirectory(current?: string): Promise<string | undefined> {
    const folders = fileWorkspaceFolders();
    const items: DirPickItem[] = [];
    const seen = new Set<string>();
    const key = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));

    const add = (dir: string, label: string, detail: string) => {
        if (seen.has(key(dir)) || !isDirectory(dir)) {
            return;
        }
        seen.add(key(dir));
        const isCurrent = current !== undefined && key(current) === key(dir);
        items.push({
            label: `$(folder) ${label}`,
            description: dir + (isCurrent ? '  (current)' : ''),
            detail,
            dir,
        });
    };

    const wsFileDir = workspaceFileDir();
    if (wsFileDir) {
        add(wsFileDir, path.basename(wsFileDir) || wsFileDir, 'Directory containing the .code-workspace file');
    }
    const ancestor = commonAncestor(folders.map((f) => f.uri.fsPath));
    if (ancestor) {
        add(ancestor, path.basename(ancestor) || ancestor, 'Common parent of all workspace folders');
    }
    for (const folder of folders) {
        add(folder.uri.fsPath, folder.name, 'Workspace folder');
    }
    if (current) {
        add(current, path.basename(current) || current, 'Current working directory');
    }
    items.push({ label: '$(folder-opened) Browse…', detail: 'Choose any directory', browse: true });

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Kiro: Select the directory kiro-cli should start in',
        placeHolder: 'kiro-cli reads .kiro/steering, specs and runs tools relative to this directory',
        matchOnDescription: true,
        ignoreFocusOut: true,
    });
    if (!picked) {
        return undefined;
    }
    if (picked.browse) {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Start kiro-cli here',
            defaultUri: current ? vscode.Uri.file(current) : folders[0]?.uri,
        });
        return uris?.[0]?.fsPath;
    }
    return picked.dir;
}
