import { AgentWorkbench } from "@/framework/client/agent-workbench";
import { FrameworkWorkbench } from "@/framework/client/framework-workbench";

export const dynamic = "force-dynamic";

/** FW 工作台统一路由（/fw 与 /fw/s/:id 同一 page）：
 *  会话创建/切换时 React 复用组件实例，不再整页重挂载闪烁。
 *  配置页 /fw/w/:ws/agents/:aid 有更具体的路由优先匹配，这里仅兜底。 */
export default async function FrameworkPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  if (slug[0] === "w" && slug[1] && slug[2] === "agents" && slug[3]) {
    return <AgentWorkbench workspaceId={slug[1]} agentId={slug[3]} />;
  }
  const sessionId = slug[0] === "s" && slug[1] ? slug[1] : null;
  return <FrameworkWorkbench sessionId={sessionId} />;
}
