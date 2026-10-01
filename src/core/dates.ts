const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const EPOCH_MILLIS = /^\d{10,}$/;

/**
 * Parse a date bound to epoch millis: epoch millis, ISO date (`2026-09-01`), or ISO datetime.
 * Date-only values use local time: start of day, or end of day when `endOfDay` is set
 * (so `--to 2026-09-30` includes meetings on the 30th).
 */
export function parseDateBoundToMillis(raw: string | number, endOfDay = false): number {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new Error(`Invalid date: ${raw}`);
    return Math.trunc(raw);
  }
  const value = String(raw).trim();
  if (EPOCH_MILLIS.test(value)) return Number(value);
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    const date = endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
      throw new Error(`Invalid date: ${value}`);
    }
    return date.getTime();
  }
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    throw new Error(`Invalid date: ${value} (use YYYY-MM-DD, an ISO datetime, or epoch millis)`);
  }
  return millis;
}
