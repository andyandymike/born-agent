export type RunResourcePhaseV1 = "runtime" | "persistence";

export interface RunResourceCloseFailureV1 {
  readonly error: unknown;
  readonly name: string;
  readonly phase: RunResourcePhaseV1;
}

interface RunResourceEntryV1 {
  closed: boolean;
  readonly close: () => Promise<void> | void;
  readonly name: string;
  readonly phase: RunResourcePhaseV1;
}

/** A small idempotent owner for resources acquired by one Agent execution. */
export class RunResourceScope {
  private readonly entries: RunResourceEntryV1[] = [];
  private readonly closing = new Map<
    RunResourcePhaseV1,
    Promise<readonly RunResourceCloseFailureV1[]>
  >();

  add(
    name: string,
    close: () => Promise<void> | void,
    phase: RunResourcePhaseV1 = "runtime",
  ): void {
    if (this.closing.has(phase)) {
      throw new Error(`cannot add ${name} after ${phase} cleanup started`);
    }
    this.entries.push({ close, closed: false, name, phase });
  }

  closePhase(
    phase: RunResourcePhaseV1,
  ): Promise<readonly RunResourceCloseFailureV1[]> {
    const existing = this.closing.get(phase);
    if (existing !== undefined) return existing;
    const closing = this.closeEntries(phase);
    this.closing.set(phase, closing);
    return closing;
  }

  async close(): Promise<readonly RunResourceCloseFailureV1[]> {
    const runtime = await this.closePhase("runtime");
    const persistence = await this.closePhase("persistence");
    return Object.freeze([...runtime, ...persistence]);
  }

  private async closeEntries(
    phase: RunResourcePhaseV1,
  ): Promise<readonly RunResourceCloseFailureV1[]> {
    const failures: RunResourceCloseFailureV1[] = [];
    for (const entry of this.entries) {
      if (entry.phase !== phase || entry.closed) continue;
      entry.closed = true;
      try {
        await entry.close();
      } catch (error) {
        failures.push(Object.freeze({ error, name: entry.name, phase }));
      }
    }
    return Object.freeze(failures);
  }
}
