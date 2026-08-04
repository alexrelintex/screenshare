export function formatTotal(total: number, count: number): string {
  if (!Number.isFinite(total)) throw new TypeError("total must be finite");
  return `${count} value(s) sum to ${total}`;
}
