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
 * fileMatch and manual ones, so the extension attaches those to the prompt.
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

/**
 * Converts a glob to a RegExp. Supports `**`, `*`, `?`, `{a,b}` and `[...]`.
 * Matching is case-insensitive on Windows.
 */
export function globToRegExp(glob: string, platform: NodeJS.Platform = process.platform): RegExp {
    let re = '';
    let inGroup = false;
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                // `**/` matches zero or more directories; a trailing `**` matches anything
                const followedBySlash = glob[i + 2] === '/';
                re += followedBySlash ? '(?:.*/)?' : '.*';
                i += followedBySlash ? 2 : 1;
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '{') {
            inGroup = true;
            re += '(?:';
        } else if (c === '}' && inGroup) {
            inGroup = false;
            re += ')';
        } else if (c === ',' && inGroup) {
            re += '|';
        } else if (c === '[') {
            const end = glob.indexOf(']', i + 1);
            if (end === -1) {
                re += '\\[';
            } else {
                re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
                i = end;
            }
        } else {
            re += c.replace(/[.+^$()|\\]/g, '\\$&');
        }
    }
    return new RegExp('^' + re + '$', platform === 'win32' ? 'i' : '');
}

/**
 * True if `relativePath` (relative to the project, any separator) matches the
 * glob. Patterns without a `/` also match against the file name alone, so
 * `*.ts` matches `src/app.ts`.
 */
export function matchesGlob(relativePath: string, glob: string, platform: NodeJS.Platform = process.platform): boolean {
    const p = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    const g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!g) {
        return false;
    }
    const re = globToRegExp(g, platform);
    if (re.test(p)) {
        return true;
    }
    return !g.includes('/') && re.test(p.split('/').pop() ?? p);
}

/** `#name` references in a message (letters, digits, `-`, `_`, `.`). */
export function referencedRuleNames(message: string): string[] {
    const names = new Set<string>();
    for (const m of message.matchAll(/(?:^|[\s(])#([A-Za-z0-9][\w.-]*)/g)) {
        names.add(m[1].replace(/\.md$/i, '').toLowerCase());
    }
    return [...names];
}

export interface AppliedRule {
    rule: Rule;
    reason: string;
}

/**
 * Rules kiro-cli won't load on its own that should accompany this message:
 * fileMatch rules matching the active file, and manual rules referenced by
 * `#name`. Project rules win over global rules with the same name.
 */
export function rulesToAttach(rules: Rule[], message: string, activeRelativePath: string | null): AppliedRule[] {
    const referenced = new Set(referencedRuleNames(message));
    const applied = new Map<string, AppliedRule>();
    const ordered = [...rules].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1));
    for (const rule of ordered) {
        const key = rule.name.toLowerCase();
        if (applied.has(key) || !rule.body) {
            continue;
        }
        if (rule.inclusion === 'manual' && referenced.has(key)) {
            applied.set(key, { rule, reason: `#${rule.name}` });
        } else if (rule.inclusion === 'fileMatch' && activeRelativePath) {
            const hit = rule.patterns.find((g) => matchesGlob(activeRelativePath, g));
            if (hit) {
                applied.set(key, { rule, reason: `matches ${hit}` });
            }
        }
    }
    return [...applied.values()];
}

/** Formats attached rules as a block to prepend to the prompt. */
export function formatRulesBlock(applied: AppliedRule[]): string {
    if (applied.length === 0) {
        return '';
    }
    const parts = ['[Rules to follow for this message]'];
    for (const { rule, reason } of applied) {
        parts.push(`--- Rule: ${rule.name} (${reason}) ---`, rule.body);
    }
    parts.push('[End of rules]');
    return parts.join('\n');
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
