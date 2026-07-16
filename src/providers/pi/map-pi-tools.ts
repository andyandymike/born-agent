import type { ModelEvent } from "../../model/model-events.js";

type ToolDeltaEvent = Extract<ModelEvent, { readonly type: "tool_call_delta" }>;

type ToolState = {
  readonly chunks: string[];
  callId?: string;
  ended: boolean;
  emittedChunks: number;
  name?: string;
};

export class PiToolProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PiToolProtocolError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function argumentsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class PiToolCallAggregator {
  readonly #callIds = new Set<string>();
  readonly #states = new Map<number, ToolState>();
  #completed = 0;

  get completedCount(): number {
    return this.#completed;
  }

  get hasOpenCalls(): boolean {
    return [...this.#states.values()].some((state) => !state.ended);
  }

  start(contentIndex: number, callId?: string, name?: string): void {
    if (!Number.isInteger(contentIndex) || contentIndex < 0 || this.#states.has(contentIndex)) {
      throw new PiToolProtocolError("invalid_tool_call_start");
    }
    const state: ToolState = {
      chunks: [],
      ended: false,
      emittedChunks: 0,
      ...(callId === undefined ? {} : { callId }),
      ...(name === undefined ? {} : { name }),
    };
    this.#states.set(contentIndex, state);
    this.#validateHeader(state);
  }

  delta(
    contentIndex: number,
    argumentsDelta: string,
    callId?: string,
    name?: string,
  ): ToolDeltaEvent[] {
    const state = this.#openState(contentIndex);
    this.#mergeHeader(state, callId, name);
    if (typeof argumentsDelta !== "string") {
      throw new PiToolProtocolError("invalid_tool_arguments_delta");
    }
    state.chunks.push(argumentsDelta);
    return this.#flush(state);
  }

  end(
    contentIndex: number,
    callId: string,
    name: string,
    finalArguments: unknown,
  ): ToolDeltaEvent[] {
    const state = this.#openState(contentIndex);
    this.#mergeHeader(state, callId, name);
    this.#validateHeader(state);
    if (!argumentsObject(finalArguments)) {
      throw new PiToolProtocolError("tool_arguments_must_be_object");
    }

    if (state.chunks.length === 0) {
      state.chunks.push(JSON.stringify(finalArguments));
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(state.chunks.join(""));
      } catch {
        throw new PiToolProtocolError("malformed_tool_arguments");
      }
      if (!argumentsObject(parsed) || canonical(parsed) !== canonical(finalArguments)) {
        throw new PiToolProtocolError("conflicting_tool_arguments");
      }
    }
    const output = this.#flush(state);
    state.ended = true;
    this.#completed += 1;
    return output;
  }

  #flush(state: ToolState): ToolDeltaEvent[] {
    if (state.callId === undefined || state.name === undefined) return [];
    const output = state.chunks.slice(state.emittedChunks).map((argumentsDelta) => ({
      argumentsDelta,
      callId: state.callId as string,
      name: state.name as string,
      type: "tool_call_delta" as const,
    }));
    state.emittedChunks = state.chunks.length;
    return output;
  }

  #mergeHeader(state: ToolState, callId?: string, name?: string): void {
    if (callId !== undefined) {
      if (state.callId !== undefined && state.callId !== callId) {
        throw new PiToolProtocolError("conflicting_tool_call_id");
      }
      state.callId = callId;
    }
    if (name !== undefined) {
      if (state.name !== undefined && state.name !== name) {
        throw new PiToolProtocolError("conflicting_tool_name");
      }
      state.name = name;
    }
    this.#validateHeader(state);
  }

  #openState(contentIndex: number): ToolState {
    const state = this.#states.get(contentIndex);
    if (state === undefined || state.ended) {
      throw new PiToolProtocolError("tool_call_without_open_start");
    }
    return state;
  }

  #validateHeader(state: ToolState): void {
    if (
      state.callId !== undefined &&
      (state.callId.length === 0 || state.callId.length > 200)
    ) {
      throw new PiToolProtocolError("invalid_tool_call_id");
    }
    if (
      state.name !== undefined &&
      !/^[a-z][a-z0-9_]{0,63}$/u.test(state.name)
    ) {
      throw new PiToolProtocolError("invalid_tool_name");
    }
    if (state.callId !== undefined && !this.#callIds.has(state.callId)) {
      this.#callIds.add(state.callId);
    } else if (
      state.callId !== undefined &&
      [...this.#states.values()].some(
        (other) => other !== state && other.callId === state.callId,
      )
    ) {
      throw new PiToolProtocolError("duplicate_tool_call_id");
    }
  }
}

