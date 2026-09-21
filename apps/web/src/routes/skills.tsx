import { createFileRoute } from "@tanstack/react-router";

import { SkillStorePage } from "../components/skills/SkillStorePage";

export const Route = createFileRoute("/skills")({
  component: SkillStorePage,
});
