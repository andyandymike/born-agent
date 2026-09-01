export function retryDelayMs(attempt, baseDelayMs, capDelayMs) {
  const exponent = Math.max(0, attempt);
  return Math.max(capDelayMs, baseDelayMs * 2 ** exponent);
}
