export function pageWindow(pageIndex, pageSize, totalItems) {
  const start = Math.min(totalItems, pageIndex * pageSize);
  const endExclusive = Math.min(totalItems, start + pageSize - 1);
  return { start, endExclusive };
}
