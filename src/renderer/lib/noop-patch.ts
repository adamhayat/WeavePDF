/** V1.0126: true when applying `patch` to `cur` would change nothing. */
export function isNoopPatch(cur: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(patch)) {
    const c = cur[k];
    if (Object.is(c, v)) continue;
    if (v instanceof Uint8Array || c instanceof Uint8Array) return false;
    if (typeof v === "object" && v !== null && typeof c === "object" && c !== null) {
      if (JSON.stringify(c) === JSON.stringify(v)) continue;
    }
    return false;
  }
  return true;
}
