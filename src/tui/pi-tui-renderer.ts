import {
  ProcessTerminal,
  TUI,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";

import {
  BornAgentViewComponent,
  type BornAgentViewComponentOptions,
} from "./components/bornagent-view.js";
import type { TuiEphemeralState } from "./tui-ephemeral-state.js";
import type { TuiViewState } from "./tui-view-state.js";

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h\u001b[H";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";

class AlternateScreenTerminal implements Terminal {
  #delegateStartAttempted = false;
  #restoreAttempted = false;
  #startAttempted = false;

  constructor(private readonly delegate: Terminal) {}

  get columns(): number {
    return this.delegate.columns;
  }

  get rows(): number {
    return this.delegate.rows;
  }

  get kittyProtocolActive(): boolean {
    return this.delegate.kittyProtocolActive;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    if (this.#startAttempted) {
      throw new Error("alternate-screen terminal can only be started once");
    }
    this.#startAttempted = true;
    try {
      // Enter before raw mode so a partial ProcessTerminal.start still has a
      // known screen to restore in the catch path.
      this.delegate.write(ENTER_ALTERNATE_SCREEN);
      this.#delegateStartAttempted = true;
      this.delegate.start(onInput, onResize);
    } catch (error) {
      const cleanupFailures = this.#restore();
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "terminal start and restore failed",
          { cause: error },
        );
      }
      throw error;
    }
  }

  stop(): void {
    const failures = this.#restore();
    if (failures.length > 0) {
      throw new AggregateError(failures, "terminal restore failed");
    }
  }

  async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    await this.delegate.drainInput(maxMs, idleMs);
  }

  write(data: string): void {
    this.delegate.write(data);
  }

  moveBy(lines: number): void {
    this.delegate.moveBy(lines);
  }

  hideCursor(): void {
    this.delegate.hideCursor();
  }

  showCursor(): void {
    this.delegate.showCursor();
  }

  clearLine(): void {
    this.delegate.clearLine();
  }

  clearFromCursor(): void {
    this.delegate.clearFromCursor();
  }

  clearScreen(): void {
    this.delegate.clearScreen();
  }

  setTitle(title: string): void {
    this.delegate.setTitle(title);
  }

  setProgress(active: boolean): void {
    this.delegate.setProgress(active);
  }

  #restore(): unknown[] {
    if (this.#restoreAttempted || !this.#startAttempted) return [];
    this.#restoreAttempted = true;
    const failures: unknown[] = [];
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };

    // PHASE11: each recovery operation is independent. A raw-mode failure must
    // not prevent alternate-screen leave or the final visible-cursor restore.
    if (this.#delegateStartAttempted) attempt(() => this.delegate.stop());
    attempt(() => this.delegate.write(LEAVE_ALTERNATE_SCREEN));
    attempt(() => this.delegate.showCursor());
    return failures;
  }
}

export type PiTuiInputListenerResult =
  | { readonly consume?: boolean; readonly data?: string }
  | undefined;

export interface PiTuiSurface {
  addChild(component: Component): void;
  addInputListener(
    listener: (data: string) => PiTuiInputListenerResult,
  ): () => void;
  removeChild(component: Component): void;
  requestRender(force?: boolean): void;
  start(): void;
  stop(): void;
}

export interface PiTuiRendererOptions extends BornAgentViewComponentOptions {
  readonly onInput?: (data: string) => PiTuiInputListenerResult;
  readonly surface?: PiTuiSurface;
  readonly terminal?: Terminal;
}

export interface PiTuiRenderer {
  start(view: TuiViewState, ephemeral: TuiEphemeralState): void;
  stop(): void;
  update(view: TuiViewState, ephemeral: TuiEphemeralState): void;
}

export function createPiTuiRenderer(
  options: PiTuiRendererOptions = {},
): PiTuiRenderer {
  if (options.surface !== undefined && options.terminal !== undefined) {
    throw new Error("provide either a pi-tui surface or terminal, not both");
  }

  const surface =
    options.surface ??
    new TUI(new AlternateScreenTerminal(options.terminal ?? new ProcessTerminal()));
  let component: BornAgentViewComponent | null = null;
  let removeInputListener: (() => void) | null = null;

  const unmountAndStop = (): unknown[] => {
    const mounted = component;
    if (mounted === null) return [];
    component = null;
    const listenerCleanup = removeInputListener;
    removeInputListener = null;
    const failures: unknown[] = [];
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    if (listenerCleanup !== null) attempt(listenerCleanup);
    attempt(() => surface.removeChild(mounted));
    attempt(() => surface.stop());
    return failures;
  };

  return {
    start(view, ephemeral) {
      if (component !== null) {
        component.update(view, ephemeral);
        surface.requestRender();
        return;
      }

      component = new BornAgentViewComponent(view, ephemeral, {
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
        ...(options.transcriptViewportRows === undefined
          ? {}
          : { transcriptViewportRows: options.transcriptViewportRows }),
      });
      try {
        surface.addChild(component);
        if (options.onInput !== undefined) {
          removeInputListener = surface.addInputListener((data) => {
            return options.onInput?.(data);
          });
        }
        // PHASE11: the renderer forwards bytes but never turns them into intents;
        // only the controller may authorize an approval, cancellation, or submit.
        surface.start();
      } catch (error) {
        const cleanupFailures = unmountAndStop();
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            [error, ...cleanupFailures],
            "pi-tui start and restore failed",
            { cause: error },
          );
        }
        throw error;
      }
    },
    stop() {
      const failures = unmountAndStop();
      if (failures.length > 0) {
        throw new AggregateError(failures, "pi-tui stop failed");
      }
    },
    update(view, ephemeral) {
      if (component === null) {
        throw new Error("pi-tui renderer must be started before update");
      }
      component.update(view, ephemeral);
      surface.requestRender();
    },
  };
}
