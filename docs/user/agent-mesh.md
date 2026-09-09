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

## Choosing a model for delegated work

Agents with mesh read access can discover configured models, their reasoning options, and cached
readiness before assigning work. An agent can keep routine work on a cheaper model and request a
bounded review from a model you selected for stronger judgment, including through another provider.
An explicit selection determines the spawned worker; omitting it inherits the caller's saved model.

Existing bot listings include their configured model and reasoning options. These are configuration,
not proof that a particular turn ran with that model. The lead should collect the completed result
and check its evidence. Unavailable credentials, incompatible runtime modes, and missing tools still
need resolution before that path can work.

## Bot computers

Compatible Linux and macOS environments can give an active Bot a persistent Linux desktop. The
computer belongs to the Bot's existing thread and isolated worktree; it is not another agent or
conversation. Starting, resuming, suspending, resetting, and destroying the computer are safe to
retry. Suspending retains its Chromium profile. Destroying removes both the container and profile,
while resetting removes both and starts a clean computer immediately.

On web or desktop, open **Bots**, select a Bot, then use the **Computer** pane at the top of its
workspace. On mobile, open **Settings → Bots** and select one from the list. The viewer works over
local, remote, relay, and tunnel connections. Desktop opens remote viewers in your browser; web and
mobile show the desktop in the app. The Bot's provider can inspect and control the same desktop
through ConvergeOS MCP screenshot, pointer, keyboard, and scroll tools.

The first version requires you to explicitly allow outbound network access when starting,
resuming, or resetting. It never injects host credentials or mounts your home directory, but files
and secrets already present inside the Bot worktree remain available because that worktree is the
computer's workspace. Viewer links are short-lived and limited to one Bot computer. Suspending,
resetting, or destroying the computer invalidates its current viewer link; resuming or resetting
automatically obtains a fresh one.

Bot computers use constrained Docker containers. This is useful isolation, not containment for
hostile code. Do not use one to run code you would not trust inside a local container.
