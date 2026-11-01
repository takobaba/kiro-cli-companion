# Kiro CLI Companion

A companion for the [Kiro CLI](https://kiro.dev) inside VS Code: chat beside your code, plan features, manage rules, and see what Kiro uses. Works on Windows, macOS and Linux.

> Requires `kiro-cli`, installed separately from [kiro.dev](https://kiro.dev). This is a community extension, not an official Kiro product.

## Getting started

1. Install `kiro-cli` and run `kiro-cli login`, or use **Kiro: Set API Key** if you'd rather not log in through a browser.
2. Click the `>_` **Kiro CLI Companion** icon in the activity bar, or run **Kiro: Open Chat** from the Command Palette.

The extension finds `kiro-cli` on its own. If it can't, set `kiro.cliPath` to the full path of the executable.

## Features

- **Streaming chat** with Markdown, code blocks and tool-call status.
- **Editor context:** your active file or selection is sent with each message.
- **Models and agents** come straight from your `kiro-cli`, so new models appear without an extension update.
- **Slash commands** like `/context`, `/plan` and `/agent` are passed to the CLI exactly as typed.
- **Working directory** shown under the header. Click it to change where `kiro-cli` runs; multi-root workspaces ask once.
- **Plan a Feature (Spec):** before writing code, Kiro drafts the requirements (what), a design (how) and a task list (steps). You review each one, type changes if needed, then continue. Saved to `.kiro/specs/<name>/`, then ask: *"implement task 1 from the &lt;name&gt; spec"*.
- **What Kiro Uses** sidebar: see your rules, specs, custom agents, skills and MCP servers, for the project and globally.

## Rules

Rules are Markdown files in `.kiro/steering/` (project) or `~/.kiro/steering/` (all projects) that tell Kiro your conventions. Create one with **Kiro: New Rule** or the **+** in the sidebar. Each rule has one of three modes:

| Mode | Applied |
|---|---|
| Always | to every message |
| For matching files | when the active file matches a pattern, e.g. `**/*.test.ts` |
| Only when I ask | when you type `#rule-name` in the chat |

The chat shows which rules it attached to a message.

## Commands

| Command | |
|---|---|
| Kiro: Open Chat | Open the chat panel |
| Kiro: Plan a Feature (Spec) | Plan a feature step by step before coding |
| Kiro: New Rule / Open Rules Folder | Create a rule, or open the rules folder |
| Kiro: Select Working Directory | Choose where `kiro-cli` runs |
| Kiro: Restart CLI | Restart `kiro-cli` with a fresh session |
| Kiro: Login / Set API Key / Clear API Key | Authenticate |

## Settings

| Setting | |
|---|---|
| `kiro.cliPath` | Path to `kiro-cli`. Leave empty to detect it automatically. |
| `kiro.workingDirectory` | Folder `kiro-cli` starts in. Supports `${workspaceFolder}`, `${workspaceFileDir}`, `~` and relative paths. |

## Troubleshooting

- **CLI not found:** check **View → Output → Kiro CLI** to see where it searched, then set `kiro.cliPath`.
- **Internal error or session stopped responding:** run **Kiro: Restart CLI**.
- **Stuck in plan mode:** pick `kiro_default` in the agent dropdown, or click 🗑 to start a new session.

## License

[MIT](LICENSE)
