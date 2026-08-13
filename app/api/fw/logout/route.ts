import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getServerEnvironment } from "@/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 退出登录：清除本域（.zmzai.cloud）的 session cookie。auth 侧的会话文档
 *  由 TTL 过期清理。前端调完跳 /fw 即可。 */
export async function POST() {
  const environment = getServerEnvironment();
  const name = environment.SESSION_COOKIE_NAME;
  const cookieStore = await cookies();
  cookieStore.delete(name);
  // 显式带 domain 再删一次，兼容 set-cookie 时带了 domain 的写法。
  cookieStore.delete({ name, domain: environment.SESSION_COOKIE_DOMAIN ?? undefined, path: "/" });
  return NextResponse.json({ ok: true });
}
