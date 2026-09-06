import { createFileRoute } from "@tanstack/react-router";

import { SchedulesPage } from "../components/schedules/SchedulesPage";

export const Route = createFileRoute("/schedules")({
  component: SchedulesPage,
});
