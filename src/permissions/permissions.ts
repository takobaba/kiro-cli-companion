/**
 * Locates kiro-cli V3 permission files:
 *   user:      ~/.kiro/settings/permissions.yaml
 *   workspace: ~/.kiro/workspace-roots/<hash>/permissions.yaml (or .json)
 *
 * The workspace hash mirrors kiro-cli's own: sha256 of the normalized
 * workspace root, first 16 hex characters. Workspace files live outside the
 * repository, so a cloned repo can't grant itself permissions.
 * See https://kiro.dev/docs/permissions/
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type PermissionScope = 'user' | 'workspace';

export interface PermissionsFile {
    scope: PermissionScope;
    /** The file to open: an existing one, or where a new one would be created. */
    filePath: string;
    exists: boolean;
    /** Number of `rules` entries (0 when missing or unreadable). */
    ruleCount: number;
    /** Names under `policies:` (e.g. approve-for-me). */
    policies: string[];
}

const FILE_NAMES = ['permissions.yaml', 'permissions.json'];

/**
 * Normalizes a path the way kiro-cli does before hashing: absolute, forward
 * slashes, no trailing slash (except a root), lower-case on Windows.
 */
export function normalizeWorkspaceRoot(root: string, platform: NodeJS.Platform = process.platform): string {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const absolute = p.isAbsolute(root) ? root : p.resolve(root);
    const slashed = absolute.replace(/\\/g, '/');
    const isUnc = platform === 'win32' && slashed.startsWith('//');
    let normalized = path.posix.normalize(slashed);
    if (isUnc && !normalized.startsWith('//')) {
        normalized = '/' + normalized;
    }
    if (normalized.length > 1) {
        const trimmed = normalized.replace(/\/+$/, '');
        if (trimmed.length > 0 && !/^[A-Za-z]:$/.test(trimmed)) {
            normalized = trimmed;
        }
    }
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** The `<hash>` folder name kiro-cli uses for a workspace root. */
export function workspaceRootHash(root: string, platform: NodeJS.Platform = process.platform): string {
    return crypto.createHash('sha256').update(normalizeWorkspaceRoot(root, platform)).digest('hex').substring(0, 16);
}

export function userPermissionsDir(home: string): string {
    return path.join(home, '.kiro', 'settings');
}

export function workspacePermissionsDir(home: string, workspaceRoot: string): string {
    return path.join(home, '.kiro', 'workspace-roots', workspaceRootHash(workspaceRoot));
}

/** Template written when the user creates a permissions file from the sidebar. */
export function permissionsTemplate(scope: PermissionScope, workspaceRoot?: string): string {
    const where = scope === 'user' ? 'all projects' : `the workspace ${workspaceRoot ?? ''}`.trim();
    return [
        `# Kiro CLI V3 permissions for ${where}.`,
        '# Rules: capability (shell, fs_read, fs_write, web_fetch, mcp, …), match globs, effect (allow, ask, deny).',
        '# Deny always wins across scopes. Docs: https://kiro.dev/docs/permissions/',
        'rules: []',
        '#  - capability: shell',
        '#    match: ["git *", "npm run *"]',
        '#    effect: allow',
        '',
    ].join('\n');
}

/** Reads one scope's permissions file (or where it would go). */
export function readPermissionsFile(scope: PermissionScope, dir: string): PermissionsFile {
    for (const name of FILE_NAMES) {
        const filePath = path.join(dir, name);
        let text: string;
        try {
            text = fs.readFileSync(filePath, 'utf-8');
        } catch {
            continue;
        }
        return { scope, filePath, exists: true, ...summarize(text, name.endsWith('.json')) };
    }
    return { scope, filePath: path.join(dir, FILE_NAMES[0]), exists: false, ruleCount: 0, policies: [] };
}

/** Both permission files for a workspace root. */
export function readPermissionFiles(home: string, workspaceRoot: string): PermissionsFile[] {
    return [
        readPermissionsFile('workspace', workspacePermissionsDir(home, workspaceRoot)),
        readPermissionsFile('user', userPermissionsDir(home)),
    ];
}

/**
 * Counts rules and lists policies without a YAML dependency. Good enough for
 * a summary; kiro-cli itself is the authority on what the file means.
 */
export function summarize(text: string, isJson: boolean): { ruleCount: number; policies: string[] } {
    if (isJson) {
        try {
            const json = JSON.parse(text) as { rules?: unknown; policies?: unknown };
            return {
                ruleCount: Array.isArray(json.rules) ? json.rules.length : 0,
                policies: Array.isArray(json.policies) ? json.policies.filter((p): p is string => typeof p === 'string') : [],
            };
        } catch {
            return { ruleCount: 0, policies: [] };
        }
    }
    let section: 'rules' | 'policies' | null = null;
    /** Indentation of the section's own list items; deeper items are nested (e.g. `match:` lists). */
    let itemIndent = -1;
    let ruleCount = 0;
    const policies: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
        if (!line.trim()) {
            continue;
        }
        const top = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (top) {
            section = top[1] === 'rules' ? 'rules' : top[1] === 'policies' ? 'policies' : null;
            itemIndent = -1;
            const inline = top[2].trim();
            if (section === 'policies' && inline.startsWith('[')) {
                policies.push(...inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean));
            }
            continue;
        }
        const item = /^(\s*)-\s*(.*)$/.exec(line);
        if (!item || !section) {
            continue;
        }
        if (itemIndent < 0) {
            itemIndent = item[1].length;
        }
        if (item[1].length !== itemIndent) {
            continue;
        }
        if (section === 'rules') {
            ruleCount++;
        } else {
            policies.push(item[2].trim().replace(/^["']|["']$/g, ''));
        }
    }
    return { ruleCount, policies };
}
