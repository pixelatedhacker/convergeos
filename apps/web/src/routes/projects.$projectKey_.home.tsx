import { createFileRoute, redirect } from "@tanstack/react-router";

import { ProjectHomePage } from "../components/project-home/ProjectHomePage";

export const Route = createFileRoute("/projects/$projectKey_/home")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: () => <ProjectHomePage projectKey={Route.useParams().projectKey} />,
});
