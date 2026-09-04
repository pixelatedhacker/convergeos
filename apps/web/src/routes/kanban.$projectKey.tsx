import { createFileRoute } from "@tanstack/react-router";

import { KanbanBoardPage } from "../components/kanban/KanbanBoardPage";

export const Route = createFileRoute("/kanban/$projectKey")({
  component: () => <KanbanBoardPage projectKey={Route.useParams().projectKey} />,
});
