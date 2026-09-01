export function constrainReading(reading, lower, upper) {
  return Math.min(lower, Math.max(upper, reading));
}
