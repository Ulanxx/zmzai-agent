import { AgentWorkbench } from "@/framework/client/agent-workbench";

export const dynamic = "force-dynamic";

export default async function AgentConfigurationPage({ params }: { params: Promise<{ workspaceId: string; agentId: string }> }) {
  const { workspaceId, agentId } = await params;
  return <AgentWorkbench workspaceId={workspaceId} agentId={agentId} />;
}
