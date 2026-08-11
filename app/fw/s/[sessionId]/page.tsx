import { FrameworkWorkbench } from "@/framework/client/framework-workbench";

export const dynamic = "force-dynamic";

export default async function FrameworkSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <FrameworkWorkbench sessionId={sessionId} />;
}
