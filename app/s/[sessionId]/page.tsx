import { AgentWorkbench } from "@/components/agent-workbench";

export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <AgentWorkbench initialSessionId={sessionId} />;
}
