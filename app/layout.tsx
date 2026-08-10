import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent 使 · zmzai cloud",
  description: "Agent 编排与工作流 · zmzai cloud 子产品",
};

export const viewport: Viewport = { themeColor: "#F4EFE6" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
