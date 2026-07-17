export interface CapturedTerminalMode {
  readonly rawMode: boolean;
}

export interface TerminalLifecyclePort {
  attachHandlers(): void;
  captureOriginalMode(): CapturedTerminalMode;
  detachHandlers(): void;
  enterAlternateScreen(): void;
  hideCursor(): void;
  leaveAlternateScreen(): void;
  restoreCursor(): void;
  restoreRawMode(mode: CapturedTerminalMode): void;
  enableRawMode(): void;
}

export class TerminalLifecycle {
  private alternateScreenEntered = false;
  private handlersAttached = false;
  private originalMode: CapturedTerminalMode | null = null;
  private rawModeEnabled = false;
  private restored = false;

  public constructor(private readonly port: TerminalLifecyclePort) {}

  public start(): void {
    if (this.originalMode !== null || this.restored) {
      throw new Error("terminal lifecycle can only be started once");
    }
    this.originalMode = this.port.captureOriginalMode();
    try {
      this.alternateScreenEntered = true;
      this.port.enterAlternateScreen();
      this.rawModeEnabled = true;
      this.port.enableRawMode();
      this.port.hideCursor();
      this.handlersAttached = true;
      this.port.attachHandlers();
    } catch (error) {
      this.restore();
      throw error;
    }
  }

  public restore(): void {
    if (this.restored) return;
    this.restored = true;
    const failures: unknown[] = [];
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };

    // PHASE11: raw/alternate cleanup is idempotent and every operation is
    // attempted, because exception paths still have to return a usable terminal.
    if (this.handlersAttached) attempt(() => this.port.detachHandlers());
    if (this.rawModeEnabled && this.originalMode !== null) {
      attempt(() => this.port.restoreRawMode(this.originalMode!));
    }
    if (this.alternateScreenEntered) {
      attempt(() => this.port.leaveAlternateScreen());
    }
    attempt(() => this.port.restoreCursor());

    if (failures.length > 0) {
      throw new AggregateError(failures, "terminal restore failed");
    }
  }
}

export async function withTerminalLifecycle<T>(
  lifecycle: TerminalLifecycle,
  run: () => Promise<T>,
): Promise<T> {
  lifecycle.start();
  try {
    return await run();
  } finally {
    lifecycle.restore();
  }
}
