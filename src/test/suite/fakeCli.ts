/**
 * Creates an executable "kiro-cli" launcher for tests that runs
 * test-fixtures/fake-kiro-cli.js with the test host's own runtime
 * (Electron in Node mode), so no separate Node install is needed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let cached: string | undefined;

export function fakeCliPath(): string {
    if (cached && fs.existsSync(cached)) {
        return cached;
    }
    // out/test/suite → repo root
    const script = path.resolve(__dirname, '..', '..', '..', 'test-fixtures', 'fake-kiro-cli.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-fake-cli-'));
    if (process.platform === 'win32') {
        cached = path.join(dir, 'kiro-cli.cmd');
        fs.writeFileSync(
            cached,
            `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${script}" %*\r\n`
        );
    } else {
        cached = path.join(dir, 'kiro-cli');
        fs.writeFileSync(cached, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${script}" "$@"\n`);
        fs.chmodSync(cached, 0o755);
    }
    return cached;
}
