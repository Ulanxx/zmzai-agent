/**
 * 朱文方印 — 品牌唯一签名 motif（design.md 锁定）。
 * 印泥红边 + 暖纸底 + 印泥红「使」字，四边等距、衬线字形。
 */
export function Seal({ size = 64, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Agent 使印" className={className}>
      <rect x="5" y="5" width="90" height="90" rx="3" fill="var(--color-paper)" stroke="var(--color-accent)" strokeWidth="7" />
      <text x="50" y="67" textAnchor="middle" fontSize="46" fontWeight="700" fill="var(--color-accent)" fontFamily="var(--font-serif), 'Songti SC', 'SimSun', serif">使</text>
    </svg>
  );
}
