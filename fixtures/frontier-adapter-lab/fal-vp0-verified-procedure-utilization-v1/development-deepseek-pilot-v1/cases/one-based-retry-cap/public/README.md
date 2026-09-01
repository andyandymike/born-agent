# One-based capped retry delay

`retryDelayMs(attempt, baseDelayMs, capDelayMs)` receives a one-based attempt.
Attempt one uses the base delay, later attempts double geometrically, and no
returned delay exceeds the hard cap.

Use the repository's executable verifier before treating a repair as complete.
