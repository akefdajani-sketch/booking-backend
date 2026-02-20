export function startOfDayISO(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function endOfDayISO(date: Date): string {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export function clampDateRange(
  from: Date,
  to: Date
): { from: Date; to: Date } {
  if (from > to) {
    return { from: to, to: from };
  }
  return { from, to };
}
