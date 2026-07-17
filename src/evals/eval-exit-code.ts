export type EvalExitCode = 0 | 1 | 2 | 9 | 130;

const EXIT_PRIORITY: readonly EvalExitCode[] = [130, 1, 2, 9, 0];

export function selectEvalExitCode(facts: readonly EvalExitCode[]): EvalExitCode {
  for (const code of EXIT_PRIORITY) {
    if (facts.includes(code)) {
      return code;
    }
  }
  return 0;
}
