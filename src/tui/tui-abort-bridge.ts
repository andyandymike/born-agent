export class TuiAbortBridge {
  private readonly listeners = new Set<() => void>();

  public readonly onCancel = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public cancelActiveRun(): void {
    // PHASE11: raw Ctrl+C is translated into the existing core abort channel;
    // it never exits the app or writes a process exit code while a run is active.
    for (const listener of [...this.listeners]) listener();
  }

  public get activeListenerCount(): number {
    return this.listeners.size;
  }
}
