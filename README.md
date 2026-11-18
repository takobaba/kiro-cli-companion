# Kiro CLI Companion

Manage everything [Kiro](https://kiro.dev) uses from the VS Code sidebar, and chat with `kiro-cli` in a terminal beside your code. Windows, macOS and Linux.

> Requires `kiro-cli` from [kiro.dev](https://kiro.dev). Community extension, not an official Kiro product.

## Getting started

1. Install `kiro-cli` and run `kiro-cli login` (or use **Kiro: Set API Key**).
2. Click the `>_` icon in the activity bar to see what Kiro uses in this project, or run **Kiro: Open Chat**.

## The sidebar: what Kiro uses

`kiro-cli` reads its configuration from files in `.kiro/` (this project) and `~/.kiro/` (all projects). The **What Kiro Uses** view lists them in one place, updates as the files change, and opens any file with a click.

- **Rules:** your conventions in `.kiro/steering/` or `~/.kiro/steering/`. **New Rule** walks you through where the rule applies and what to call it. **Open Rules Folder** gets you to the files.
- **Specs:** every feature plan in `.kiro/specs/`, with how many of its three docs exist. **Plan a feature…** starts a new one.
- **Permissions:** tool rules for this workspace and for all projects, with the rule count and policies. If a file doesn't exist yet, **create…** starts it from a commented template.
- **Custom Agents, Skills and MCP Servers:** what's configured, at project or global level, including disabled MCP servers.

## Chat and specs

- **Chat:** **Kiro: Open Chat** runs `kiro-cli chat` in a terminal beside your editor. Every `kiro-cli` chat feature works as-is: slash commands, models, agents and tool permissions.
- **Sessions:** `kiro-cli` saves every turn, so closing the terminal or VS Code loses nothing. **Open Chat** continues the latest session in the working directory (`kiro-cli chat --resume`). **Kiro: Resume Session...** picks a different saved session, and **Kiro: New Chat** starts over.
- **Plan a Feature (Spec):** starts a Kiro chat that writes requirements → design → tasks to `.kiro/specs/<name>/`, asking Kiro to stop for your review after each step. The spec shows up in the sidebar as it's written.
- **API key:** **Kiro: Set API Key** stores it in VS Code SecretStorage and passes it to `kiro-cli` as `KIRO_API_KEY`.

## Settings

- `kiro.cliPath`: path to `kiro-cli` (auto-detected if empty).
- `kiro.workingDirectory`: folder `kiro-cli` starts in.
- `kiro.chatSession`: what **Open Chat** opens: `resume` the latest session (default), `pick` one each time, or always start `new`.
- `kiro.chatArguments`: extra `kiro-cli chat` arguments, e.g. `["--agent", "my-agent"]`. Chat uses `--v3` unless you pass `--v2`.

## Troubleshooting

- **CLI not found:** see **Output → Kiro CLI**, then set `kiro.cliPath`.
- **Stuck or signed out:** run **Kiro: Restart CLI**. It restarts `kiro-cli` and continues the same conversation. Use **Kiro: New Chat** for a clean slate.

## License

[MIT](LICENSE)
