# Kiro CLI Chat

A chat panel for the [Kiro CLI](https://kiro.dev) inside VS Code. It works on Windows, macOS and Linux.

> Requires `kiro-cli`, installed separately from [kiro.dev](https://kiro.dev). This is a community extension, not an official Kiro product.

## Getting started

1. Install `kiro-cli` and run `kiro-cli login`, or use **Kiro: Set API Key** if you'd rather not log in through a browser.
2. Run **Kiro: Open Chat** from the Command Palette.

The extension finds `kiro-cli` on its own. If it can't, set `kiro.cliPath` to the full path of the executable.

## Features

- **Streaming chat** with Markdown, code blocks and tool-call status.
- **Editor context:** your active file or selection is sent with each message.
- **Models and agents** come straight from your `kiro-cli`, so new models appear without an extension update.
- **Slash commands** like `/context`, `/plan` and `/agent` are passed to the CLI exactly as typed.
- **Working directory** shown under the header. Click it to change where `kiro-cli` runs; multi-root workspaces ask once.
- **Spec workflow:** requirements → design → tasks, saved to `.kiro/specs/`.

## Commands

| Command | |
|---|---|
| Kiro: Open Chat | Open the chat panel |
| Kiro: Start Spec | Start a spec workflow |
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

[MIT](LICENSE.md)
