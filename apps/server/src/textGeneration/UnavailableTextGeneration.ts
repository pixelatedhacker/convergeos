import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TextGeneration from "./TextGeneration.ts";

function unavailable(operation: string, providerName: string) {
  return new TextGenerationError({
    operation,
    detail: `${providerName} does not support system text-generation tasks.`,
  });
}

export function makeUnavailableTextGeneration(
  providerName: string,
): TextGeneration.TextGeneration["Service"] {
  return TextGeneration.TextGeneration.of({
    generateCommitMessage: () => Effect.fail(unavailable("generateCommitMessage", providerName)),
    generatePrContent: () => Effect.fail(unavailable("generatePrContent", providerName)),
    generateBranchName: () => Effect.fail(unavailable("generateBranchName", providerName)),
    generateThreadTitle: () => Effect.fail(unavailable("generateThreadTitle", providerName)),
  });
}
