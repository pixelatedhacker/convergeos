/**
 * A bot profile's description is the bot's standing instructions. Every turn
 * dispatched to a bot thread, whether from the Bots page, a Kanban card, or
 * another agent's `agents_send`, carries them ahead of the task so the role
 * does not have to be restated by each caller. The persisted user message keeps
 * only the task; composition happens at the provider boundary.
 */
export function composeBotTurnInput(
  botProfile: { readonly description: string | null } | null | undefined,
  text: string,
): string {
  const instructions = botProfile?.description?.trim();
  if (!instructions) return text;
  const task = text.trim();
  const header = `<bot_instructions>\n${instructions}\n</bot_instructions>`;
  return task.length > 0 ? `${header}\n\n${task}` : header;
}
