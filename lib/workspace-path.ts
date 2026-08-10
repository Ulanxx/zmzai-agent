const deniedRoots = new Set([".env", ".git", ".ssh", "node_modules"]);

export function canonicalWorkspacePath(value: string): string | null {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.length > 512 || path.startsWith("/")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) return null;
  if (deniedRoots.has(segments[0])) return null;
  return segments.join("/");
}
