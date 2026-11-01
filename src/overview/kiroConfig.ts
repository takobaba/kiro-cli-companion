/**
 * Reads what Kiro has configured for a project and for the user:
 * rules (steering), specs, custom agents, skills and MCP servers.
 *
 * Project items live in `<cwd>/.kiro/`, global ones in `~/.kiro/`.
 * No `vscode` imports so it can be unit tested in plain Node.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Rule, globalRulesDir, listRulesIn, projectRulesDir } from '../rules/rules';

export type Scope = 'project' | 'global';

export interface SpecInfo {
    name: string;
    dir: string;
    /** Existing documents in phase order. */
    docs: Array<{ phase: 'requirements' | 'design' | 'tasks'; filePath: string }>;
}

export interface FileItem {
    name: string;
    filePath: string;
    scope: Scope;
    description: string;
}

export interface McpServer {
    name: string;
    scope: Scope;
    /** mcp.json the server is defined in. */
    configPath: string;
    /** "command args…" or the URL. */
    detail: string;
    disabled: boolean;
}

export interface KiroConfig {
    rules: Rule[];
    specs: SpecInfo[];
    agents: FileItem[];
    skills: FileItem[];
    mcpServers: McpServer[];
    projectDir: string;
    globalDir: string;
}

const PHASES = ['requirements', 'design', 'tasks'] as const;

function readDirSafe(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

function readJsonSafe(filePath: string): unknown {
    try {
        // Tolerate // comments and trailing commas, as in VS Code-style JSON
        const text = fs.readFileSync(filePath, 'utf-8')
            .replace(/^\uFEFF/, '')
            .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? '')
            .replace(/,(\s*[}\]])/g, '$1');
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

export function listSpecs(kiroDir: string): SpecInfo[] {
    const specsDir = path.join(kiroDir, 'specs');
    return readDirSafe(specsDir)
        .filter((e) => e.isDirectory())
        .map((e) => {
            const dir = path.join(specsDir, e.name);
            const docs = PHASES.flatMap((phase) => {
                const filePath = path.join(dir, `${phase}.md`);
                return fs.existsSync(filePath) ? [{ phase, filePath }] : [];
            });
            return { name: e.name, dir, docs };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function listAgents(kiroDir: string, scope: Scope): FileItem[] {
    const dir = path.join(kiroDir, 'agents');
    return readDirSafe(dir)
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
        .map((e) => {
            const filePath = path.join(dir, e.name);
            const json = readJsonSafe(filePath) as { name?: string; description?: string } | undefined;
            return {
                name: json?.name || path.basename(e.name, '.json'),
                filePath,
                scope,
                description: json?.description || '',
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function listSkills(kiroDir: string, scope: Scope): FileItem[] {
    const dir = path.join(kiroDir, 'skills');
    return readDirSafe(dir)
        .filter((e) => e.isDirectory())
        .flatMap((e) => {
            const filePath = path.join(dir, e.name, 'SKILL.md');
            if (!fs.existsSync(filePath)) {
                return [];
            }
            let description = '';
            try {
                const m = fs.readFileSync(filePath, 'utf-8').match(/^description:\s*(.+)$/m);
                description = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
            } catch {
                // ignore
            }
            return [{ name: e.name, filePath, scope, description }];
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function listMcpServers(kiroDir: string, scope: Scope): McpServer[] {
    const configPath = path.join(kiroDir, 'settings', 'mcp.json');
    const json = readJsonSafe(configPath) as { mcpServers?: Record<string, Record<string, unknown>> } | undefined;
    const servers = json?.mcpServers;
    if (!servers || typeof servers !== 'object') {
        return [];
    }
    return Object.entries(servers)
        .map(([name, cfg]) => {
            const command = typeof cfg?.command === 'string' ? cfg.command : '';
            const args = Array.isArray(cfg?.args) ? (cfg.args as unknown[]).map(String).join(' ') : '';
            const url = typeof cfg?.url === 'string' ? cfg.url : '';
            return {
                name,
                scope,
                configPath,
                detail: url || [command, args].filter(Boolean).join(' '),
                disabled: cfg?.disabled === true,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads everything Kiro has configured for `cwd` and `home`. */
export function readKiroConfig(cwd: string, home: string): KiroConfig {
    const projectKiro = path.join(cwd, '.kiro');
    const globalKiro = path.join(home, '.kiro');
    // Avoid listing global items twice when the CLI runs in the home directory
    const sameDir = path.resolve(projectKiro).toLowerCase() === path.resolve(globalKiro).toLowerCase();
    const both = <T>(fn: (dir: string, scope: Scope) => T[]): T[] =>
        sameDir ? fn(globalKiro, 'global') : [...fn(projectKiro, 'project'), ...fn(globalKiro, 'global')];

    return {
        rules: sameDir
            ? listRulesIn(globalRulesDir(home), 'global')
            : [...listRulesIn(projectRulesDir(cwd), 'project'), ...listRulesIn(globalRulesDir(home), 'global')],
        specs: sameDir ? [] : listSpecs(projectKiro),
        agents: both(listAgents),
        skills: both(listSkills),
        mcpServers: both(listMcpServers),
        projectDir: projectKiro,
        globalDir: globalKiro,
    };
}
