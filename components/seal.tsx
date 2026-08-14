/**
 * Seal — 品牌标志。
 * v2: 使用 @zmzai/theme Logo（云朵 PNG），替代 v1 朱文方印。
 * 保持 { size, className } 接口兼容。
 */
import { Logo } from "@zmzai/theme/brand";

export function Seal({ size = 64, className = "" }: { size?: number; className?: string }) {
  return <Logo size={size} className={className} />;
}
