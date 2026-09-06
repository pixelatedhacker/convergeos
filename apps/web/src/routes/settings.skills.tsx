import { createFileRoute } from "@tanstack/react-router";
import { SkillStoreSettingsPanel } from "../components/settings/SkillStoreSettings";
export const Route = createFileRoute("/settings/skills")({ component: SkillStoreSettingsPanel });
