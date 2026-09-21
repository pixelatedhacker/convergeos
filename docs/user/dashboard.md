# Command center

The command center shows what your agents are doing across your connected machines. Open it from
the sidebar or with the command palette's **Open command center**.

The **Machines** cards show each connection, the number of threads working or needing you, and the
next thread to open. Select a card to go straight to that thread. Threads needing your input take
priority over running work, followed by your most recent open thread. When a machine is disconnected,
the card shows its last known work so you can see where you left off. Use **Manage connections** to
add or reconnect a machine.

On mobile, the home screen shows a compact machine strip when you have multiple environments. Tap a
machine name to see its threads, or tap the thread underneath to open it immediately. **Show all**
returns to the combined thread list. The strip stays out of search results.

Four cards make up the page:

- **Needs attention** — threads waiting on you: pending approvals, unanswered questions, proposed
  plans ready to review, and failed sessions. Select a row to jump straight to the thread. Snoozed
  threads stay hidden here until their snooze expires.
- **Running now** — threads with work in flight, with how long each has been going. Background
  monitors show as **Monitoring**.
- **Schedules** — the next few scheduled runs across your projects and the most recent runs. Select
  a run to open the thread it created, or **Manage schedules** to edit them.
- **Subscription quota** — the tightest remaining allowance per provider account, per environment,
  with reset times. Environments that cannot report quota are listed as unavailable without
  hiding the rest.

The cards use the same thread state already synced by each client. Opening a thread from another
device continues work on its original machine; it does not move the thread or its checkout.
