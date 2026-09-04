# Agent mesh

Agent mesh lets one running agent work with other agent threads in the same project. It uses the
threads you already have, so delegated work keeps its normal conversation history, provider,
permissions, and checkpoints.

Agent mesh access is off by default. Turn on **Settings → Integrations → Agents → Agent mesh
access** to give newly started agent sessions the mesh tools. Browser access is a separate setting.
A running session keeps the tools it received when it started.

An enabled agent can:

- list active agent threads in its project;
- read the latest assistant output from one of those threads;
- send a request to an idle thread with an isolated worktree; and
- interrupt the exact running turn it previously observed.

The server never exposes threads from another project. A missing thread and a thread in another
project produce the same unavailable result.

## Workspace safety

Two full-access agents must not write to the same checkout concurrently. Sending work is therefore
allowed only when the target uses a different worktree from the calling agent. Listing, reading,
and interrupting a thread do not write to its checkout and remain available.

Delegated messages name their source thread in the visible prompt. Send and interrupt requests also
carry a caller-chosen request ID. Reusing that ID when retrying the same action prevents duplicate
turns.

Agent mesh does not create threads, choose providers, or create worktrees. Create and configure the
target thread first, then delegate to it. Bots make selected isolated threads easier to recognize
and reuse as stable destinations.

## Bots

A bot is an isolated thread with a name and a durable inbox. Create a worktree-backed thread, open
its thread menu, and choose **Make this thread a bot**. The bot initially uses the thread title as
its name. Rename the thread and choose **Use thread title as bot name** when you want to update it.

Other agents can list only bots when choosing a destination. Messages still land in the bot's
original thread, so its provider settings, history, approvals, checkpoints, and worktree remain
visible in the normal conversation.

Choose **Disable bot** before archiving or deleting its inbox. Disabling removes the reusable bot
identity but keeps the thread and its history.

Project Kanban cards can name an active bot as their assignee. Assignment does not automatically
start a turn; open the bot thread or use agent mesh when the task is ready to run.
