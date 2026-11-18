/**
 * Saved kiro-cli chat sessions: parsing `kiro-cli chat --list-sessions -f json`,
 * choosing which session a new Kiro terminal opens, and the session picker.
 *
 * kiro-cli saves every conversation turn per directory, so a session survives
 * its terminal closing and can be continued with --resume / --resume-id.
 */

import * as vscode from 'vscode';

export interface KiroSession {
    id: string;
    title: string;
    /** Last activity, if kiro-cli reported a valid timestamp. */
    updatedAt?: Date;
    /** Store the session lives in, e.g. "v3" or "v2". */
    source?: string;
    /** "local" or "cloud" (V3 only). */
    executionTarget?: string;
}

/** Which conversation a new main Kiro terminal opens. */
export type SessionChoice =
    | { kind: 'new' }
    | { kind: 'resumeLast' }
    | { kind: 'resume'; id: string };

/** Value of the `kiro.chatSession` setting. */
export type SessionMode = 'resume' | 'pick' | 'new';

/** Session IDs are UUIDs, optionally prefixed (e.g. `sess_…`). Anything else is ignored. */
const SESSION_ID = /^[\w.-]+$/;

/**
 * Parses the JSON from `kiro-cli chat --list-sessions -f json`: an array of
 * `{ cwd, sessions: [{ sessionId, title, updatedAt, source, executionTarget }] }`.
 * Returns the sessions newest first. Throws if the output isn't JSON.
 */
export function parseSessionList(json: string): KiroSession[] {
    const data: unknown = JSON.parse(json);
    const envelopes = Array.isArray(data) ? data : [data];
    const sessions: KiroSession[] = [];
    for (const envelope of envelopes) {
        const list = (envelope as { sessions?: unknown } | null)?.sessions;
        if (!Array.isArray(list)) {
            continue;
        }
        for (const raw of list) {
            const s = raw as Record<string, unknown> | null;
            const id = s?.sessionId;
            if (typeof id !== 'string' || !SESSION_ID.test(id)) {
                continue;
            }
            const updated = typeof s!.updatedAt === 'string' ? new Date(s!.updatedAt) : undefined;
            sessions.push({
                id,
                title: typeof s!.title === 'string' && s!.title.trim() ? s!.title.trim() : '(no title)',
                updatedAt: updated && !isNaN(updated.getTime()) ? updated : undefined,
                source: typeof s!.source === 'string' ? s!.source : undefined,
                executionTarget: typeof s!.executionTarget === 'string' ? s!.executionTarget : undefined,
            });
        }
    }
    return sessions.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
}

/** `kiro-cli chat` arguments for a session choice. */
export function sessionArgs(choice: SessionChoice | undefined): string[] {
    switch (choice?.kind) {
        case 'resumeLast':
            return ['--resume'];
        case 'resume':
            return ['--resume-id', choice.id];
        default:
            return [];
    }
}

/** Flags that already tell kiro-cli which session to open. */
const SESSION_FLAGS = new Set(['-r', '--resume', '--resume-id', '--resume-picker', '--sessions']);

/** True if `kiro.chatArguments` already chooses the session, so the extension shouldn't. */
export function hasSessionFlag(args: string[]): boolean {
    return args.some((a) => SESSION_FLAGS.has(a.split('=')[0]));
}

/** The `kiro.chatSession` setting. */
export function sessionModeFromSetting(): SessionMode {
    const value = vscode.workspace.getConfiguration('kiro').get<string>('chatSession', 'resume');
    return value === 'pick' || value === 'new' ? value : 'resume';
}

/** "5 min ago", "yesterday", "3 days ago"… */
export function relativeTime(date: Date, now: Date = new Date()): string {
    const minutes = Math.round((now.getTime() - date.getTime()) / 60000);
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    }
    const days = Math.round(hours / 24);
    if (days === 1) {
        return 'yesterday';
    }
    if (days < 30) {
        return `${days} days ago`;
    }
    return date.toLocaleDateString();
}

interface SessionPickItem extends vscode.QuickPickItem {
    choice: SessionChoice;
}

/**
 * Asks which saved session to continue, with "New Session" first.
 * Returns undefined if the picker was dismissed.
 */
export async function pickSession(sessions: KiroSession[], directory: string): Promise<SessionChoice | undefined> {
    const items: SessionPickItem[] = [
        { label: '$(add) New Session', description: 'Start a fresh conversation', choice: { kind: 'new' } },
        ...sessions.map((s): SessionPickItem => ({
            label: s.title,
            description: [s.updatedAt ? relativeTime(s.updatedAt) : undefined, s.executionTarget === 'cloud' ? 'cloud' : undefined]
                .filter(Boolean)
                .join(' · '),
            detail: s.id,
            choice: { kind: 'resume', id: s.id },
        })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Kiro: Resume Session',
        placeHolder: `Continue a saved kiro-cli session from ${directory}`,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    return picked?.choice;
}
