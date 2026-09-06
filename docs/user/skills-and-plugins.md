# Skills and plugins

Open **Settings → Skills & plugins** on web, desktop, or mobile. Choose the environment and provider instance you want to manage. Paths refer to that environment's computer, including when you connect remotely.

The Skills tab shows the provider's reported skills, their enabled state, scope, and file location. Enter a project directory and select **Use directory** to inspect project skills. Select **Refresh** after changes made outside ConvergeOS.

For Codex, use **Enable** or **Disable** to change whether an existing skill is available. This writes Codex's own configuration. Providers that do not expose supported skill enablement controls only show the current state.

## Import a skill

For Codex, Claude Code, and Cursor, choose user or project scope and enter an existing package directory on the selected environment. The directory must contain `SKILL.md` with a name and description in its YAML frontmatter. Its references and scripts are copied with it. An existing destination is never replaced.

The import is an independent copy. Editing the source does not update the installed copy. To update it, remove the imported copy and import the source again. Removal deletes edits made inside that copy, but leaves the original source unchanged. ConvergeOS only offers removal for copies it imported. Packages containing symbolic links need to be copied into an ordinary directory first.

Start a new provider session to load changed packages. If you use more than one provider instance with the same skill directory, an import or removal affects each instance that reads that directory.

## Manage Claude Code plugins

**Installed plugins** shows the current user and selected project's installations. **Discover plugins** uses the marketplaces already configured in that Claude Code instance. Each entry identifies its source. Review it before installing: plugins can contain scripts, hooks, and MCP servers.

Choose the installation scope, then install a plugin. Installed entries have enable, disable, and uninstall controls for their recorded scope. A package can be installed in more than one scope. Claude reports effective enablement, which can include project overrides.

Marketplace setup and plugins requiring an interactive command approval or configuration remain in the Claude Code CLI. ConvergeOS reports the provider's error if a command cannot finish. Codex, Cursor, Grok, OpenCode, OMP, and Antigravity plugin formats are not managed by this page yet. Their reported skills remain available to inspect.
