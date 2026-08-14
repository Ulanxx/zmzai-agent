import Link from "next/link";
import { Wordmark as ThemeWordmark } from "@zmzai/theme/brand";

/**
 * zmzai wordmark — v2 使用 @zmzai/theme Wordmark。
 * 保持 { className } 接口兼容。
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return <ThemeWordmark className={className} />;
}

export function WordmarkLink({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="inline-flex items-baseline">
      <Wordmark />
    </Link>
  );
}
