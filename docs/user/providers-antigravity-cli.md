# Antigravity CLI

Antigravity CLI runs the `agy` command on the environment that hosts your project. It uses that
environment's CLI sign-in and configuration. Web, desktop, and mobile clients control the same
host, so your phone does not need its own CLI installation.

**Antigravity CLI** and **Antigravity** are separate providers. The Antigravity provider uses
Google's ACP agent and has its own installation and sign-in. Choose that provider when you need
interactive approvals. See [Antigravity setup](./providers-antigravity.md).

## Set up the CLI

1. Follow Google's [CLI installation guide](https://antigravity.google/docs/cli/install/) on the
   environment that runs your project.
2. Run `agy` interactively on that environment and complete sign-in.
3. Run `agy models` to check the available model names.
4. On web or desktop, open **Settings** > **Providers** and enable **Antigravity CLI** for that
   environment. If `agy` is not on its `PATH`, set **Binary path** to the executable.
5. Select an Antigravity CLI model in the thread's model picker.
6. Select **Full access** before sending your message.

The provider is off by default. ConvergeOS does not install, update, or sign in to the CLI for you.
A successful model list confirms model discovery. Your first successful conversation confirms
that the CLI account can run the selected model.

## Permission and conversation limits

Antigravity CLI supports **Full access** in ConvergeOS. Its headless interface cannot send interactive
approval requests back to the client. **Supervised**, **Auto-accept edits**, and **Auto** are
unavailable. A thread with one of those modes keeps its selection until you change it.

Full access allows commands and file edits without approval prompts. Choose the separate
Antigravity provider if you want to review tool actions before they run.

Send text messages. Native image input, interactive questions, Plan mode, and conversation rewind
are unavailable through this integration. CLI slash commands and steering an active turn are
unsupported. Wait for a turn to finish, or stop it before sending a follow-up.

Stopping a turn stops its CLI process. Later messages resume the same native conversation on the
same environment. You can select a different model for the next turn. Models with effort levels
appear as separate choices, using the names returned by the CLI.
Deleting the native CLI conversation or moving to a different environment prevents that resume.

The CLI uses its configured MCP servers. Current Antigravity CLI releases do not expose a
per-process MCP configuration option, so ConvergeOS treats this provider as leaf-only: it does not
automatically add project tools or the agent mesh, and a delegated task running here cannot create
another ConvergeOS worker. ConvergeOS never writes its short-lived session credential into the
CLI's shared user or workspace configuration.

## Troubleshoot a connection

If the provider cannot find the CLI, run `agy --help` on the environment and check **Binary path**.
The executable must support `--input-format stream-json` and `--output-format stream-json`.

If sign-in is required, run `agy` interactively on the host, complete sign-in, and retry the
conversation. Refresh provider status after changing CLI installation or model configuration.

If a resumed conversation fails, check that the native conversation still exists under the same
CLI account and working directory. Start a new thread if its native history has been removed.
