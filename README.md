# Kiro CLI Companion

Chat with the [Kiro CLI](https://kiro.dev) beside your code in VS Code. Windows, macOS and Linux.

> Requires `kiro-cli` from [kiro.dev](https://kiro.dev). Community extension, not an official Kiro product.

## Getting started

1. Install `kiro-cli` and run `kiro-cli login` (or use **Kiro: Set API Key**).
2. Click the `>_` icon in the activity bar, or run **Kiro: Open Chat**.

## Features

- Streaming chat that sends your active file or selection with each message.
- Runs `kiro-cli acp --agent-engine=v3`. Models and modes come straight from `kiro-cli`.
- **Tool permissions:** Allow / Deny cards in the chat. "Always" choices can be saved for this workspace, all projects, or the session.
- **Plan a Feature (Spec):** requirements → design → tasks, saved to `.kiro/specs/`.
- **Rules** in `.kiro/steering/` (or `~/.kiro/steering/`), applied always, for matching files, or when you type `#rule-name`.
- **What Kiro Uses** sidebar: rules, specs, agents, skills, MCP servers and permissions. Type `/help` in the chat for commands.

## Settings

- `kiro.cliPath`: path to `kiro-cli` (auto-detected if empty).
- `kiro.workingDirectory`: folder `kiro-cli` starts in.

## Troubleshooting

- **CLI not found:** see **Output → Kiro CLI**, then set `kiro.cliPath`.
- **Not responding:** run **Kiro: Restart CLI**.

## License

[MIT](LICENSE)
