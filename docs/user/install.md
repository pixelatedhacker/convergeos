# Install ConvergeOS

ConvergeOS runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch ConvergeOS and configure providers afterwards.

## Command line

```bash
curl -fsSL https://raw.githubusercontent.com/pixelatedhacker/convergeos/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/pixelatedhacker/convergeos/main/scripts/install.ps1 | iex
```

This puts `convergeos` in `~/.local/bin`. If your shell reports `command not found`
afterwards, that directory is not on your `PATH` yet; the installer prints the
line to add. Set `CONVERGEOS_CHANNEL=nightly` to install the nightly train, or
`CONVERGEOS_VERSION` to pin an exact version.

| Task                                             | Command                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| Start the server and open the web app            | `convergeos`                                                      |
| Start the server without a browser               | `convergeos serve`                                                |
| Keep it running in the background (macOS, Linux) | `convergeos service install` ([details](./background-service.md)) |
| Move to the newest release                       | `convergeos update`                                               |
| Remove it again                                  | `convergeos uninstall`                                            |

Run `convergeos --help` for the full reference.

To try ConvergeOS once without installing it, run `npx @convergeos/cli@latest` instead (needs
Node.js for `npx`).

### Intel Macs

There is no `convergeos` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with Node.js 24 and `vp`
([Install vp](https://github.com/pixelatedhacker/convergeos#install-vp)):

```bash
git clone https://github.com/pixelatedhacker/convergeos
cd convergeos && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`convergeos update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download a ConvergeOS build from [GitHub Releases](https://github.com/pixelatedhacker/convergeos/releases).
Install it alongside T3 Code as a separate application.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. ConvergeOS installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
convergeos app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `convergeos app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Running beside T3 Code

ConvergeOS and T3 Code can run on the same computer. ConvergeOS uses the
`convergeos` command, stores its state under `~/.convergeos`, and starts its
server on port `4773`. Desktop chooses another available port if needed.
Use `CONVERGEOS_HOME`, `CONVERGEOS_PORT`, or the corresponding command flags
when you want different settings. T3 Code's home and port variables do not
configure ConvergeOS.

Each app keeps its own thread history, settings, browser profile, and background
service. ConvergeOS handles `convergeos://` links; T3 Code keeps `t3code://` links.
Both can use installed provider CLIs and the same repositories. Use separate
worktrees when agents in both apps will edit a project at the same time.

Earlier ConvergeOS builds reused T3 Code's desktop browser profile. This version
starts a separate profile, so you may need to sign in again. Existing thread
history under `~/.convergeos` remains available. If you configured a previous
ConvergeOS install with `T3CODE_HOME`, set `CONVERGEOS_HOME` to that directory
explicitly, and keep it separate from a running T3 Code server.

## Mobile app

Use a ConvergeOS mobile build and connect it to the pairing URL for the
ConvergeOS server. See [remote access](./remote-access.md). Running both desktop
apps does not imply that their clients and servers are interchangeable.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from ConvergeOS's provider settings.                         |

Provider CLIs must be on the server's `PATH`. If ConvergeOS cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when ConvergeOS can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, ConvergeOS does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating ConvergeOS](./updating.md): update the app and connected servers.
