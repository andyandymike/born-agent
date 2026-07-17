import type {
  PiTuiRenderer,
  PiTuiRendererOptions,
} from "./pi-tui-renderer.js";

export interface TuiHost {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  createRenderer(options: PiTuiRendererOptions): PiTuiRenderer;
}
