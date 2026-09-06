import { SkillStoreError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { openCodexSkillsClient } from "./Layers/CodexProvider.ts";

export const setCodexSkillEnabled = Effect.fn("setCodexSkillEnabled")(function* (
  input: Parameters<typeof openCodexSkillsClient>[0] & {
    readonly skillPath: string;
    readonly enabled: boolean;
  },
) {
  const client = yield* openCodexSkillsClient(input);
  const list = () => client.request("skills/list", { cwds: [input.cwd], forceReload: true });
  const before = yield* list();
  const skill = before.data
    .find((entry) => entry.cwd === input.cwd)
    ?.skills.find((entry) => entry.path === input.skillPath);
  if (!skill) {
    return yield* new SkillStoreError({
      message: "This skill is no longer in the selected provider's catalog. Refresh the list.",
    });
  }
  yield* client.request("skills/config/write", { path: skill.path, enabled: input.enabled });
  const after = yield* list();
  const updated = after.data
    .find((entry) => entry.cwd === input.cwd)
    ?.skills.find((entry) => entry.path === skill.path);
  if (updated?.enabled !== input.enabled) {
    return yield* new SkillStoreError({
      message:
        "Codex did not apply the requested skill state. Check its configuration and policies.",
    });
  }
  return {
    message: `Skill ${input.enabled ? "enabled" : "disabled"}. Start a new provider session to load the change.`,
  };
});
