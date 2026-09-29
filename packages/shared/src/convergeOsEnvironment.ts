export type MutableEnvironment = Record<string, string | undefined>;

export const DEFAULT_CONVERGEOS_PORT = 4773;

export const CONVERGEOS_ENV_PREFIX = "CONVERGEOS_";
export const LEGACY_T3CODE_ENV_PREFIX = "T3CODE_";

/**
 * Makes the ConvergeOS namespace canonical. Storage, networking, and installer
 * settings only accept the ConvergeOS name so an inherited T3 Code environment
 * cannot redirect this install. Other legacy settings remain accepted.
 */
export function applyConvergeOsEnvironmentAliases(environment: MutableEnvironment): void {
  // Storage, ports, and downloads belong to one product, even in a T3 Code shell.
  delete environment.T3CODE_HOME;
  delete environment.T3CODE_PORT;
  delete environment.T3CODE_RELEASE_BASE_URL;
  delete environment.T3CODE_INSTALL_BIN_DIR;

  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || !name.startsWith(LEGACY_T3CODE_ENV_PREFIX)) continue;

    const canonicalName = `${CONVERGEOS_ENV_PREFIX}${name.slice(LEGACY_T3CODE_ENV_PREFIX.length)}`;
    environment[canonicalName] ??= value;
  }

  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || !name.startsWith(CONVERGEOS_ENV_PREFIX)) continue;

    const legacyName = `${LEGACY_T3CODE_ENV_PREFIX}${name.slice(CONVERGEOS_ENV_PREFIX.length)}`;
    environment[legacyName] = value;
  }
}

export function withConvergeOsEnvironmentAliases(
  environment: Readonly<MutableEnvironment>,
): MutableEnvironment {
  const normalized = { ...environment };
  applyConvergeOsEnvironmentAliases(normalized);
  return normalized;
}
