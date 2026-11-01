/**
 * Cross-platform discovery of the kiro-cli binary.
 *
 * Deliberately avoids shelling out to `which` / `where`: on Windows the
 * extension host's environment, once copied into a plain object, loses its
 * case-insensitive `Path` key, so a spawned `where` may not even find
 * itself. Instead we scan PATH directories in-process, honouring PATHEXT
 * on Windows.
 *
 * Everything in this module is free of `vscode` imports so it can be unit
 * tested in plain Node.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CLI_BINARY_NAME = 'kiro-cli';

/** Environment variable users can set to point at the CLI explicitly. */
export const CLI_PATH_ENV_VAR = 'KIRO_CLI_PATH';

type Env = Record<string, string | undefined>;

/**
 * Reads a variable from an env object case-insensitively.
 * Node's `process.env` is case-insensitive on Windows, but copies of it are not.
 */
export function getEnvVar(env: Env, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
    if (platform !== 'win32') {
        return env[name];
    }
    const lower = name.toLowerCase();
    const key = Object.keys(env).find((k) => k.toLowerCase() === lower);
    return key !== undefined ? env[key] : undefined;
}

/** Expands `%VAR%` (Windows) and leading `~` references in a path string. */
export function expandPath(input: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
    let value = input.trim();
    // Strip surrounding quotes, which commonly sneak into PATH entries on Windows
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
    }
    if (platform === 'win32') {
        value = value.replace(/%([^%]+)%/g, (match, name: string) => getEnvVar(env, name, platform) ?? match);
    }
    if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
        const home = getHomeDir(env, platform);
        if (home) {
            value = path.join(home, value.slice(1));
        }
    }
    return value;
}

export function getHomeDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
    return (
        (platform === 'win32' ? getEnvVar(env, 'USERPROFILE', platform) : undefined) ||
        getEnvVar(env, 'HOME', platform) ||
        os.homedir()
    );
}

/** Returns true if `filePath` is an existing file we can execute. */
export function isExecutableFile(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            return false;
        }
        if (platform !== 'win32') {
            fs.accessSync(filePath, fs.constants.X_OK);
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Candidate file names for a binary. On Windows this expands via PATHEXT
 * (e.g. kiro-cli.exe, kiro-cli.cmd); elsewhere it's just the binary name.
 */
export function candidateFileNames(binary: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): string[] {
    if (platform !== 'win32') {
        return [binary];
    }
    if (path.extname(binary)) {
        return [binary];
    }
    const pathExt = getEnvVar(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD';
    const exts = pathExt
        .split(';')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
    // Prefer .exe so we spawn the real binary rather than a shim when both exist
    exts.sort((a, b) => (a === '.exe' ? -1 : b === '.exe' ? 1 : 0));
    return exts.map((ext) => binary + ext);
}

/** Scans a PATH-style string for `binary`. Returns the first match or null. */
export function findOnPath(
    binary: string,
    pathValue: string,
    env: Env = process.env,
    platform: NodeJS.Platform = process.platform
): string | null {
    const delimiter = platform === 'win32' ? ';' : ':';
    const names = candidateFileNames(binary, env, platform);
    for (const rawDir of pathValue.split(delimiter)) {
        if (!rawDir.trim()) {
            continue;
        }
        const dir = expandPath(rawDir, env, platform);
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (isExecutableFile(candidate, platform)) {
                return candidate;
            }
        }
    }
    return null;
}

/** Well-known install locations for kiro-cli, checked when PATH lookup fails. */
export function knownInstallLocations(env: Env = process.env, platform: NodeJS.Platform = process.platform): string[] {
    const home = getHomeDir(env, platform);
    if (platform === 'win32') {
        const localAppData = getEnvVar(env, 'LOCALAPPDATA', platform) || (home ? path.join(home, 'AppData', 'Local') : '');
        const programFiles = getEnvVar(env, 'ProgramFiles', platform) || 'C:\\Program Files';
        return [
            localAppData && path.join(localAppData, 'Kiro-Cli', 'kiro-cli.exe'),
            localAppData && path.join(localAppData, 'Programs', 'Kiro-Cli', 'kiro-cli.exe'),
            home && path.join(home, '.local', 'bin', 'kiro-cli.exe'),
            path.join(programFiles, 'Kiro-Cli', 'kiro-cli.exe'),
        ].filter((p): p is string => !!p);
    }
    return [
        home && path.join(home, '.local', 'bin', CLI_BINARY_NAME),
        '/usr/local/bin/' + CLI_BINARY_NAME,
        '/opt/homebrew/bin/' + CLI_BINARY_NAME,
    ].filter((p): p is string => !!p);
}

/**
 * Parses the output of `reg query <key> /v Path` and returns the value.
 * Example line: "    Path    REG_EXPAND_SZ    C:\Foo;%USERPROFILE%\Bar"
 */
export function parseRegQueryPath(output: string): string {
    const match = output.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im);
    return match ? match[1].trim() : '';
}

/**
 * Reads the persisted User and Machine PATH from the Windows registry.
 *
 * VS Code's extension host inherits the environment from whatever launched
 * VS Code, so a PATH edit made after launch (or a launcher with a stale
 * environment) isn't visible in `process.env`. The registry is the source
 * of truth for new processes.
 */
export async function readWindowsRegistryPath(env: Env = process.env): Promise<string> {
    const systemRoot = getEnvVar(env, 'SystemRoot', 'win32') || 'C:\\Windows';
    const regExe = path.join(systemRoot, 'System32', 'reg.exe');
    const keys = [
        'HKCU\\Environment',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    ];

    const values = await Promise.all(
        keys.map(
            (key) =>
                new Promise<string>((resolve) => {
                    execFile(regExe, ['query', key, '/v', 'Path'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
                        resolve(error ? '' : parseRegQueryPath(stdout));
                    });
                })
        )
    );
    return values.filter(Boolean).join(';');
}

/**
 * Windows batch shims (.cmd/.bat) can't be spawned directly by Node
 * (CVE-2024-27980 hardening) and need `shell: true`.
 */
export function requiresShell(cliPath: string, platform: NodeJS.Platform = process.platform): boolean {
    return platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath);
}

/**
 * Returns the command + options to pass to spawn/execFile for the CLI.
 * When a shell is required, the path is quoted to survive spaces.
 */
export function cliSpawnTarget(cliPath: string, platform: NodeJS.Platform = process.platform): { command: string; shell: boolean } {
    if (requiresShell(cliPath, platform)) {
        return { command: `"${cliPath}"`, shell: true };
    }
    return { command: cliPath, shell: false };
}

export interface LocateResult {
    path: string;
    /** Human-readable description of how the binary was found. */
    source: string;
}

export interface LocateOptions {
    /** Explicit path from the `kiro.cliPath` setting. */
    configuredPath?: string;
    env?: Env;
    platform?: NodeJS.Platform;
    /** Injected for tests; defaults to reading the Windows registry. */
    readRegistryPath?: () => Promise<string>;
    /** Optional sink for diagnostic messages. */
    log?: (message: string) => void;
}

/**
 * Locates kiro-cli. Order:
 *   1. `kiro.cliPath` setting
 *   2. KIRO_CLI_PATH environment variable
 *   3. PATH of the extension host (plus ~/.local/bin)
 *   4. (Windows) persisted User + Machine PATH from the registry
 *   5. Well-known install locations
 */
export async function locateCli(options: LocateOptions = {}): Promise<LocateResult | null> {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const log = options.log ?? (() => undefined);

    const explicit: Array<[string | undefined, string]> = [
        [options.configuredPath, 'kiro.cliPath setting'],
        [getEnvVar(env, CLI_PATH_ENV_VAR, platform), `${CLI_PATH_ENV_VAR} environment variable`],
    ];
    for (const [raw, source] of explicit) {
        if (!raw || !raw.trim()) {
            continue;
        }
        const candidate = expandPath(raw, env, platform);
        if (isExecutableFile(candidate, platform)) {
            return { path: candidate, source };
        }
        // Allow pointing at the install directory instead of the binary
        const inDir = findOnPath(CLI_BINARY_NAME, candidate, env, platform);
        if (inDir) {
            return { path: inDir, source };
        }
        log(`[locateCli] ${source} is set to "${raw}" but no executable was found there; continuing discovery.`);
    }

    const home = getHomeDir(env, platform);
    const localBin = home ? path.join(home, '.local', 'bin') : '';
    const delimiter = platform === 'win32' ? ';' : ':';
    const hostPath = [localBin, getEnvVar(env, 'PATH', platform) ?? ''].filter(Boolean).join(delimiter);

    const onPath = findOnPath(CLI_BINARY_NAME, hostPath, env, platform);
    if (onPath) {
        return { path: onPath, source: 'PATH' };
    }

    if (platform === 'win32') {
        try {
            const registryPath = await (options.readRegistryPath ?? (() => readWindowsRegistryPath(env)))();
            const fromRegistry = registryPath ? findOnPath(CLI_BINARY_NAME, registryPath, env, platform) : null;
            if (fromRegistry) {
                return { path: fromRegistry, source: 'Windows user/system PATH (registry)' };
            }
        } catch (err) {
            log(`[locateCli] Registry PATH lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    for (const candidate of knownInstallLocations(env, platform)) {
        if (isExecutableFile(candidate, platform)) {
            return { path: candidate, source: 'known install location' };
        }
    }

    return null;
}
