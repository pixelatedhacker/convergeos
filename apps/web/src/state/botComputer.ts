import { createBotComputerEnvironmentAtoms } from "@t3tools/client-runtime/state/bot-computer";

import { connectionAtomRuntime } from "../connection/runtime";

export const botComputerEnvironment = createBotComputerEnvironmentAtoms(connectionAtomRuntime);
