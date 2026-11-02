/**
 * Tests for reading kiro-cli V3 permission files (shown in the overview).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    normalizeWorkspaceRoot,
    readPermissionsFile,
    summarize,
    workspaceRootHash,
} from '../../permissions/permissions';

suite('Permission files', () => {
    test('normalizes workspace roots like kiro-cli', () => {
        assert.strictEqual(normalizeWorkspaceRoot('C:\\Users\\Me\\Repo\\', 'win32'), 'c:/users/me/repo');
        assert.strictEqual(normalizeWorkspaceRoot('C:\\', 'win32'), 'c:/');
        assert.strictEqual(normalizeWorkspaceRoot('/home/me/repo/', 'linux'), '/home/me/repo');
        assert.strictEqual(normalizeWorkspaceRoot('/home/Me/../Me/Repo', 'linux'), '/home/Me/Repo');
    });

    test('hashes the workspace root like kiro-cli', () => {
        // Recorded from kiro-cli 2.37.1: ~/.kiro/workspace-roots/5fad8110355fd5ba
        assert.strictEqual(workspaceRootHash('C:\\Users\\Administrator\\Documents\\kiro-cli-companion', 'win32'), '5fad8110355fd5ba');
        assert.strictEqual(
            workspaceRootHash('c:/users/administrator/documents/kiro-cli-companion/', 'win32'),
            workspaceRootHash('C:\\Users\\Administrator\\Documents\\kiro-cli-companion', 'win32')
        );
    });

    test('summarizes rules and policies in YAML', () => {
        const yaml = [
            '# comment',
            'rules:',
            '  - capability: shell',
            '    match: ["git *", "npm *"]',
            '    effect: allow',
            '  - capability: fs_write',
            '    match:',
            '      - "*.env"',
            '    effect: deny',
            'policies:',
            '  - approve-for-me',
            'workspaceTrusted: true',
        ].join('\n');
        assert.deepStrictEqual(summarize(yaml, false), { ruleCount: 2, policies: ['approve-for-me'] });
        assert.deepStrictEqual(summarize('rules: []\nworkspaceTrusted: true\n', false), { ruleCount: 0, policies: [] });
        assert.deepStrictEqual(summarize('rules:\n- capability: all\n  effect: allow\npolicies: [dev-shell]\n', false), { ruleCount: 1, policies: ['dev-shell'] });
    });

    test('summarizes JSON and reports missing files', () => {
        assert.deepStrictEqual(summarize('{"rules":[{},{}],"policies":["read-workspace"]}', true), { ruleCount: 2, policies: ['read-workspace'] });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-perm-'));
        try {
            const missing = readPermissionsFile('user', dir);
            assert.strictEqual(missing.exists, false);
            assert.strictEqual(missing.filePath, path.join(dir, 'permissions.yaml'));
            fs.writeFileSync(path.join(dir, 'permissions.json'), '{"rules":[{}]}');
            const found = readPermissionsFile('user', dir);
            assert.strictEqual(found.exists, true);
            assert.strictEqual(found.ruleCount, 1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
