/**
 * Rules (Kiro "steering files"): Markdown files in `.kiro/steering/` (project)
 * or `~/.kiro/steering/` (global) that tell Kiro your conventions.
 *
 * Front matter controls when a rule applies:
 *   inclusion: always     (default) — always in context
 *   inclusion: auto       — Kiro decides
 *   inclusion: fileMatch  — when files matching `fileMatchPattern` are involved
 *   inclusion: manual     — only when referenced as #rule-name
 *
 * kiro-cli (checked against 2.37.1) loads always/auto rules itself but skips
 * fileMatch and manual ones. The extension used to attach those to each
 * message from its own chat; with kiro-cli's terminal chat nothing does.
 *
 * No `vscode` imports here so it can be unit tested in plain Node.
 */

import * as fs from 'fs';
import * as path from 'path';

export type RuleInclusion = 'always' | 'auto' | 'fileMatch' | 'manual';
export type RuleScope = 'project' | 'global';

export interface Rule {
    /** File name without `.md`; used for `#name` references. */
    name: string;
    filePath: string;
    scope: RuleScope;
    inclusion: RuleInclusion;
    /** Glob patterns for `fileMatch` rules. */
    patterns: string[];
    /** Optional description from front matter. */
    description: string;
    /** Rule text without the front matter. */
    body: string;
}

/** Splits `---` front matter from the body. */
export function splitFrontMatter(text: string): { meta: Record<string, string | string[]>; body: string } {
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) {
        return { meta: {}, body: normalized };
    }
    const meta: Record<string, string | string[]> = {};
    let listKey: string | null = null;
    for (const rawLine of match[1].split('\n')) {
        const line = rawLine.replace(/\s+#.*$/, '');
        const item = line.match(/^\s*-\s+(.*)$/);
        if (item && listKey) {
            const list = Array.isArray(meta[listKey]) ? (meta[listKey] as string[]) : [];
            list.push(unquote(item[1]));
            meta[listKey] = list;
            continue;
        }
        const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (!kv) {
            continue;
        }
        const [, key, value] = kv;
        if (value === '') {
            listKey = key; // YAML list follows
            meta[key] = [];
        } else if (value.startsWith('[') && value.endsWith(']')) {
            listKey = null;
            meta[key] = value.slice(1, -1).split(',').map((v) => unquote(v)).filter(Boolean);
        } else {
            listKey = null;
            meta[key] = unquote(value);
        }
    }
    return { meta, body: match[2] };
}

function unquote(value: string): string {
    const v = value.trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        return v.slice(1, -1);
    }
    return v;
}

/** Parses a rule file's text. */
export function parseRule(text: string, filePath: string, scope: RuleScope): Rule {
    const { meta, body } = splitFrontMatter(text);
    const rawInclusion = String(meta.inclusion ?? 'always').trim();
    const inclusion: RuleInclusion =
        rawInclusion === 'fileMatch' || rawInclusion === 'manual' || rawInclusion === 'auto' ? rawInclusion : 'always';
    const rawPatterns = meta.fileMatchPattern ?? meta.fileMatchPatterns ?? [];
    const patterns = (Array.isArray(rawPatterns) ? rawPatterns : [rawPatterns]).map((p) => p.trim()).filter(Boolean);
    return {
        name: path.basename(filePath, path.extname(filePath)),
        filePath,
        scope,
        inclusion,
        patterns,
        description: typeof meta.description === 'string' ? meta.description : '',
        body: body.trim(),
    };
}

/** Lists `*.md` rules in a steering directory. Missing directories yield []. */
export function listRulesIn(dir: string, scope: RuleScope): Rule[] {
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return entries
        .filter((f) => f.toLowerCase().endsWith('.md'))
        .sort((a, b) => a.localeCompare(b))
        .flatMap((f) => {
            const filePath = path.join(dir, f);
            try {
                return [parseRule(fs.readFileSync(filePath, 'utf-8'), filePath, scope)];
            } catch {
                return [];
            }
        });
}

export function projectRulesDir(cwd: string): string {
    return path.join(cwd, '.kiro', 'steering');
}

export function globalRulesDir(home: string): string {
    return path.join(home, '.kiro', 'steering');
}

/** Short human description of when a rule applies (for the sidebar). */
export function describeInclusion(rule: Rule): string {
    switch (rule.inclusion) {
        case 'always':
            return 'always on';
        case 'auto':
            return 'auto';
        case 'fileMatch':
            return rule.patterns.length ? `when ${rule.patterns.join(', ')} open` : 'fileMatch (no pattern)';
        case 'manual':
            return `type #${rule.name}`;
    }
}

/** File contents for a new rule. */
export function newRuleTemplate(name: string, inclusion: RuleInclusion, pattern?: string): string {
    const front =
        inclusion === 'always'
            ? '---\ninclusion: always\n---\n'
            : inclusion === 'fileMatch'
                ? `---\ninclusion: fileMatch\nfileMatchPattern: "${pattern || '**/*.ts'}"\n---\n`
                : '---\ninclusion: manual\n---\n';
    const title = name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return (
        front +
        `# ${title}\n\n` +
        '<!-- Write instructions for Kiro in plain language. Examples: -->\n' +
        '- Use TypeScript strict mode; avoid `any`.\n' +
        '- Prefer small, pure functions and add unit tests for new logic.\n'
    );
}
