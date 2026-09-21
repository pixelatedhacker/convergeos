# Skill store

The skill store lets you discover third-party agent skills and install them onto your
environments without leaving ConvergeOS. It is backed by the open skills.sh registry, the same
ecosystem the `skills` CLI uses.

Open it from the **Skills & plugins** entry in the sidebar, or search for "skill store" in the command
palette. The Installed view lists the selected provider’s skills and plugins. Choose Browse skills to search the store.

## Discovering skills

Pick the environment you want to browse from the environment switcher at the top, then search
the registry. Each result shows the skill's name, its source repository, and how many times it
has been installed. Select a result to read its description and see the files it will install.

## Installing a skill

From the skill's detail view, choose:

- **Providers**, which agent runtimes get the skill, such as Claude Code, Codex, Cursor, Grok,
  OpenCode, and Antigravity. Each provider stores skills in its own format and directory; the
  install handles that for you.
- **Where to install**, either one or more environments (the skill is available to every
  project on those environments) or a single project (the skill lands in that project's
  repository and only applies there).

Installing to several environments at once runs one install per environment and reports each
outcome separately, so a failing remote does not block the others.

## Managing installed skills

The **Installed through the store** section in Browse lists installations made through the store.
It does not include skills installed manually or by another tool. Use the Installed view to see
the provider’s full catalog. Choose a project to include its local skills. For each skill you can:

- toggle individual providers on and off per install location; disabling a provider removes the
  skill from that provider only, keeping every other location and provider untouched;
- remove the skill entirely, which deletes it from every provider and scope on that environment.

Skills are installed per environment. If you run ConvergeOS on several machines, switch the
environment selector to manage each machine's set.
