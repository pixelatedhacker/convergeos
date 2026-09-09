# Skill and plugin management

The settings page sends environment-scoped RPC requests through the existing connection runtime. Web and desktop share the page; mobile has a native settings screen using the same contracts and client atoms. No marketplace index or client-local installer is introduced.

`server.getSkillStore` requires orchestration read access. `server.mutateSkillStore` requires orchestration operate access. Each request names a provider instance, plus an optional directory on the owning environment. The server resolves its current provider snapshot and settings. Account-specific environment variables, binary paths, and provider homes stay on the server.

## Provider capabilities

| Provider        | Skill inventory                                                | Import/remove copied packages                      | Existing skill enablement    | Plugins                                                           |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| Codex           | Existing provider discovery                                    | User shared home and project `.agents/skills`      | Native `skills/config/write` | Unsupported                                                       |
| Claude Code     | Existing provider discovery                                    | User config directory and project `.claude/skills` | Unsupported                  | Native CLI catalog and scoped install, enable, disable, uninstall |
| Cursor          | Existing provider discovery, including shared `.agents/skills` | User/project `.cursor/skills`                      | Unsupported                  | Unsupported                                                       |
| Other providers | Existing provider discovery where available                    | Unsupported                                        | Unsupported                  | Unsupported                                                       |

Codex overlays share the configured shared home's skills. Their import root is not the authentication overlay directory. Ambient `CODEX_HOME` applies only when direct mode has no configured home. Multiple instances using the same directory share package changes.

Imports validate the entry file's frontmatter, copy regular package contents into a temporary sibling directory, and rename the complete package into the provider root. A per-name directory lock serializes imports from this server; existing destinations are rejected. `.git`, `node_modules`, and old import metadata are excluded. Package limits are 1,000 entries and 20 MB. Symbolic links and special files are refused. An import marker records its original source, which remains untouched. Removal is confined to a direct child of a supported root and requires that marker; linked skill directories and unmanaged installations are refused.

The marker identifies ownership of a copied directory, not a security signature or an update ledger. There is no automatic source synchronization. The user confirms removal because edits inside an imported copy will be deleted.

Claude commands run against the selected instance's binary, environment, and directory. They have a two-minute timeout and bounded output. The manager does not pass `--yes` to bypass CLI approvals for command-based installs. The catalog parser keeps provider-reported errors visible, filters project installations by canonical directory, and preserves install candidates across scopes. Catalog listing is on demand with a 30-second client cache, not a subscription or background scan. Provider refresh completes before the client rereads the store after a mutation.

Native plugin changes are only claimed after successful command completion. Existing provider sessions may retain old packages. Codex skill changes are validated against a fresh native skill catalog and require enabled-state readback. The manager does not edit unsupported providers' enablement formats.
