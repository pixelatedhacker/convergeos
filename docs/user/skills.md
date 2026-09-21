# Skill store

The skill store lets you discover third-party agent skills and install them onto your
environments without leaving ConvergeOS. It is backed by the open skills.sh registry, the same
ecosystem the `skills` CLI uses.

Open it from the **Skills** entry in the sidebar, or search for "skill store" in the command
palette.

## Discovering skills

Pick the environment you want to browse from the environment switcher at the top, then search
the registry. Each result shows the skill's name, its source repository, and how many times it
has been installed. Select a result to read its description and see the files it will install.

## Installing a skill

From the skill's detail view, choose:

- **Harnesses** — which agent runtimes get the skill (Claude Code, Codex, Cursor, Grok,
  OpenCode, Antigravity). Each harness stores skills in its own format and directory; the
  install handles that for you.
- **Where to install** — either one or more environments (the skill is available to every
  project on those environments) or a single project (the skill lands in that project's
  repository and only applies there).

Installing to several environments at once runs one install per environment and reports each
outcome separately, so a failing remote does not block the others.

## Managing installed skills

The **Installed on this environment** section lists everything the selected environment has
installed. For each skill you can:

- toggle individual harnesses on and off per install location — disabling a harness removes the
  skill from that harness only, keeping every other location and harness untouched;
- remove the skill entirely, which deletes it from every harness and scope on that environment.

Skills are installed per environment. If you run ConvergeOS on several machines, switch the
environment selector to manage each machine's set.
