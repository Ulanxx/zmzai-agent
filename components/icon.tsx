"use client";

/**
 * 规范图标集 — 16px 网格、1.5px 描边、currentColor、圆角端。
 * 替代之前用 Unicode 字符（+、■、＋、✓、✗、↓）实现的按钮/状态图标。
 */
const paths: Record<string, { d: string; fill?: boolean }> = {
  plus: { d: "M8 3.5v9M3.5 8h9" },
  stop: { d: "M4.5 4.5h7v7h-7z", fill: true },
  "new-session": { d: "M4 3.5h8a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V4A.5.5 0 0 1 4 3.5zM8 6v4M6 8h4" },
  check: { d: "M3.5 8.5l3 3 6-7" },
  cross: { d: "M4.5 4.5l7 7M11.5 4.5l-7 7" },
  download: { d: "M8 3v7M5 7.5L8 10.5 11 7.5M4 12.5h8" },
  "arrow-down": { d: "M8 3.5v8M5 8.5L8 11.5 11 8.5" },
  refresh: { d: "M13 8a5 5 0 1 1-1.5-3.6M13 3.5v2.8h-2.8" },
  retry: { d: "M13 8a5 5 0 1 1-1.5-3.6M13 3.5v2.8h-2.8" },
  "chevron-down": { d: "M4 6l4 4 4-4" },
  logout: { d: "M6 4.5h7a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H6M8 8h4.5M10.5 6l2 2-2 2" },
};

export function Icon({ name, size = 14, className = "" }: { name: keyof typeof paths; size?: number; className?: string }) {
  const icon = paths[name];
  if (!icon) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      aria-hidden="true"
      fill={icon.fill ? "currentColor" : "none"}
      stroke={icon.fill ? "none" : "currentColor"}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={icon.d} />
    </svg>
  );
}
