import { notFound, redirect } from "next/navigation";

import { Logo } from "@zmzai/theme";
import { getCurrentUser } from "@/lib/auth/session";
import { isLocalDevLoginEnabled } from "@/lib/auth/local-dev-login";

export const dynamic = "force-dynamic";

export default async function LocalDevLoginPage() {
  if (!isLocalDevLoginEnabled()) notFound();
  if (await getCurrentUser()) redirect("/fw");

  return (
    <main className="dev-login-shell">
      <section className="dev-login-panel" aria-labelledby="dev-login-title">
        <div className="dev-login-mark">
          <Logo size={34} />
          <span>LOCAL DEVELOPMENT</span>
        </div>
        <div className="dev-login-copy">
          <span className="eyebrow">ZMZAI AGENT</span>
          <h1 id="dev-login-title">进入本地工作台</h1>
          <p>使用本地管理员身份创建一个 30 天调试会话。这个入口只在开发环境开放。</p>
        </div>
        <form action="/api/dev/login" method="post">
          <button className="command-button dev-login-button" type="submit">本地登录</button>
        </form>
      </section>
    </main>
  );
}
