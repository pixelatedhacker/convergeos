export type MutableEnvironment = Record<string, string | undefined>;

export const CONVERGEOS_ENV_PREFIX = "CONVERGEOS_";
export const LEGACY_T3CODE_ENV_PREFIX = "T3CODE_";

/**
 * Makes the ConvergeOS namespace canonical while keeping older launchers and
 * user configuration working during migration. When both names are present,
 * the ConvergeOS value wins.
 */
export function applyConvergeOsEnvironmentAliases(environment: MutableEnvironment): void {
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
