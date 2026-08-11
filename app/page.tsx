import { redirect } from "next/navigation";

/** 默认入口切换到 FW 协议工作台（spec §10.2 step 2：新协议成为默认）。
 *  旧 plan/build 工作台保留在 /legacy 供历史会话回放，M3 收尾时下线。 */
export default function HomePage() {
  redirect("/fw");
}
