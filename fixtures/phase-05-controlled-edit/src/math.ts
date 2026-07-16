export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(minimum, Math.max(maximum, value));
}
