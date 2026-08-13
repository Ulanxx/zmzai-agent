import { WorkspaceConfig } from "@/framework/client/workspace-config";
import { FrameworkWorkbench } from "@/framework/client/framework-workbench";

export const dynamic = "force-dynamic";

/** FW 工作台统一路由（/fw 与 /fw/s/:id 同一 page）：
 *  会话创建/切换时 React 复用组件实例，不再整页重挂载闪烁。
 *  /fw/w/:wsId → 智能体配置页。 */
export default async function FrameworkPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  if (slug[0] === "w" && slug[1]) {
    return <WorkspaceConfig workspaceId={slug[1]} />;
  }
  const sessionId = slug[0] === "s" && slug[1] ? slug[1] : null;
  return <FrameworkWorkbench sessionId={sessionId} />;
}
