# Agent mesh

Agent mesh lets one running agent work with other agent threads in the same project. It uses the
threads you already have, so delegated work keeps its normal conversation history, provider,
permissions, and checkpoints.

Agent mesh access is off by default. Turn on **Settings → Integrations → Agents → Agent mesh
access** to give newly started agent sessions the mesh tools. Browser access is a separate setting.
A running session keeps the tools it received when it started.

Agent listings report whether each provider session has the ConvergeOS MCP server attached, did
not request it, or is leaf-only. Leaf-only workers can still receive delegated work, but they
cannot recursively call ConvergeOS mesh tools through that provider session.

An enabled agent can:

- list active agent threads in its project;
- read the latest assistant output from one of those threads;
- spawn a new worker in an isolated worktree;
- send a request to an idle thread with an isolated worktree;
- wait for one of up to eight delegated turns to finish or need attention; and
- interrupt the exact running turn it previously observed.

The server never exposes threads from another project. A missing thread and a thread in another
project produce the same unavailable result.

## Workspace safety

Two full-access agents must not write to the same checkout concurrently. Sending work is therefore
allowed only when the target uses a different worktree from the calling agent. Listing, reading,
and interrupting a thread do not write to its checkout and remain available.

Each spawned or sent turn has a durable delegation record. Spawn and send requests carry a
caller-chosen request ID; retrying the same request resumes that delegation instead of starting a
duplicate turn. A wait can return when a worker completes, fails, is interrupted, or needs an
approval or user response.

Spawning creates a thread and worktree from the caller's branch. It uses the caller's model unless
the agent selects another configured model. Sending reuses an existing bot thread. Bots make those
isolated threads easier to recognize and reuse as stable destinations.

## Bots

A bot is an isolated thread with a name and a durable inbox. Create a worktree-backed thread, open
its thread menu, and choose **Make this thread a bot**. The bot initially uses the thread title as
its name. Rename the thread and choose **Use thread title as bot name** when you want to update it.

Open **Bots** from the named workspace entry in the web or desktop sidebar, or search for **Open
bots** in the command palette. The workspace keeps the fleet roster beside the selected bot's
status, project, worktree, and MCP connection. You can dispatch a task directly, open the full
conversation, edit or disable the profile, or promote an eligible isolated thread. If no isolated
thread is ready, **New bot** starts one in a project you choose. Mobile shows bot identity in thread
lists and Kanban assignments; fleet management currently lives in the web and desktop workspace.

Other agents can list only bots when choosing a destination. Messages still land in the bot's
original thread, so its provider settings, history, approvals, checkpoints, and worktree remain
visible in the normal conversation.

Choose **Disable bot** before archiving or deleting its inbox. Disabling removes the reusable bot
identity but keeps the thread and its history.

Project Kanban cards can name an active bot as their assignee. Moving an assigned card to Ready
queues it for that bot; ConvergeOS starts it when the bot is available.
