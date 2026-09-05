import { createFileRoute } from "@tanstack/react-router";

import { BotsPage } from "../components/bots/BotsPage";

export const Route = createFileRoute("/bots")({
  component: BotsPage,
});
