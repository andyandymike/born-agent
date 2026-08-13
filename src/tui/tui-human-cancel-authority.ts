export interface TuiHumanCancelTargetV1 {
  readonly runId: string;
  readonly sessionId: string;
}

export interface TuiHumanCancelResultV1 {
  readonly diagnostic: string | null;
  readonly exitCode: number;
}

/**
 * PHASE21: a human cancellation is an authenticated application mutation, not
 * an alias for the process-local abort channel. Only explicit legacy runtimes
 * without the Phase21 control plane retain the historical raw-abort behavior.
 */
export function requestTuiHumanCancel(input: Readonly<{
  readonly applicationControlEnabled: boolean;
  readonly exactTarget: TuiHumanCancelTargetV1 | null;
  readonly legacyAbort: () => void;
  readonly report: (diagnostic: string) => void;
  readonly request: (target: TuiHumanCancelTargetV1) => Promise<TuiHumanCancelResultV1>;
}>): void {
  if (!input.applicationControlEnabled) {
    input.legacyAbort();
    return;
  }
  if (input.exactTarget === null) {
    input.report("application cancel is not durably bound to an exact active run; no raw abort was sent");
    return;
  }
  void input.request(input.exactTarget).then((result) => {
    if (result.exitCode !== 0) {
      input.report(result.diagnostic ?? "application cancel was not durably accepted; no raw abort was sent");
    }
  }).catch(() => {
    input.report("application cancel failed before a durable claim; no raw abort was sent");
  });
}
