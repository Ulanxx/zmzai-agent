export function combineAgentInstructions(workspacePrompt?: string | null, projectInstructions?: string | null): string | undefined {
  const sections = [workspacePrompt, projectInstructions].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return sections.length ? sections.join("\n\n") : undefined;
}
