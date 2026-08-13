export type TuiParsedCommandV1 =
  | Readonly<{ kind: "exit" }>
  | Readonly<{ kind: "refresh" }>
  | Readonly<{ kind: "plugins" }>
  | Readonly<{ kind: "mode"; mode: "build" | "plan" }>
  | Readonly<{ kind: "session"; sessionId: string }>
  | Readonly<{ argumentsText: string; kind: "skill"; selector: string }>
  | Readonly<{ argumentsJson: string | undefined; kind: "mcp_prompt"; selector: string }>
  | Readonly<{ kind: "resume"; message: string | undefined; sessionId: string }>
  | Readonly<{ command: string; kind: "graph" }>
  | Readonly<{ confirmedAbandon: boolean; kind: "new_goal"; text: string }>
  | Readonly<{ kind: "goal_set"; text: string }>
  | Readonly<{ kind: "goal_abandon"; reason: string }>
  | Readonly<{ decision: "approve" | "approve_build"; kind: "plan_approve" }>
  | Readonly<{ kind: "plan_reject"; reason: string }>
  | Readonly<{ kind: "plan_replace"; path: string }>
  | Readonly<{ kind: "retry_or_continue"; operation: "continue" | "retry" }>
  | Readonly<{ kind: "text"; text: string }>;

type Parser = (text: string) => TuiParsedCommandV1 | null;

function match(pattern: RegExp, text: string): RegExpExecArray | null {
  pattern.lastIndex = 0;
  return pattern.exec(text);
}

/** Order is part of the stable TUI grammar; parsers are pure and state-free. */
export const TUI_COMMAND_PARSERS_V1: readonly Parser[] = Object.freeze([
  (text) => text === "exit" ? Object.freeze({ kind: "exit" }) : null,
  (text) => text === "/refresh" ? Object.freeze({ kind: "refresh" }) : null,
  (text) => text === "/plugins" ? Object.freeze({ kind: "plugins" }) : null,
  (text) => {
    const value = match(/^\/mode\s+(plan|build)\s*$/u, text)?.[1];
    return value === "build" || value === "plan" ? Object.freeze({ kind: "mode", mode: value }) : null;
  },
  (text) => {
    const value = match(/^\/session\s+(\S+)\s*$/u, text)?.[1];
    return value === undefined ? null : Object.freeze({ kind: "session", sessionId: value });
  },
  (text) => {
    const value = match(/^\/skill\s+(\S+)(?:\s+([\s\S]+))?$/u, text);
    return value?.[1] === undefined ? null : Object.freeze({ argumentsText: value[2] ?? "", kind: "skill", selector: value[1] });
  },
  (text) => {
    const value = match(/^\/mcp-prompt\s+(\S+)(?:\s+([\s\S]+))?$/u, text);
    return value?.[1] === undefined ? null : Object.freeze({ argumentsJson: value[2], kind: "mcp_prompt", selector: value[1] });
  },
  (text) => {
    const value = match(/^\/resume\s+(\S+)(?:\s+([\s\S]+))?$/u, text);
    return value?.[1] === undefined ? null : Object.freeze({ kind: "resume", message: value[2], sessionId: value[1] });
  },
  (text) => {
    const value = match(/^\/graph(?:\s+([\s\S]+))?$/u, text)?.[1]?.trim();
    return value === undefined ? null : Object.freeze({ command: value, kind: "graph" });
  },
  (text) => {
    const value = match(/^\/new(!)?\s+([\s\S]+)$/u, text);
    return value?.[2] === undefined ? null : Object.freeze({ confirmedAbandon: value[1] === "!", kind: "new_goal", text: value[2] });
  },
  (text) => {
    const value = match(/^\/goal\s+set\s+([\s\S]+)$/u, text)?.[1];
    return value === undefined ? null : Object.freeze({ kind: "goal_set", text: value });
  },
  (text) => {
    const value = match(/^\/goal\s+abandon\s+([\s\S]+)$/u, text)?.[1];
    return value === undefined ? null : Object.freeze({ kind: "goal_abandon", reason: value });
  },
  (text) => text === "/plan approve" || text === "/plan approve-build"
    ? Object.freeze({ decision: text.endsWith("-build") ? "approve_build" : "approve", kind: "plan_approve" })
    : null,
  (text) => {
    const value = match(/^\/plan\s+reject\s+([\s\S]+)$/u, text)?.[1];
    return value === undefined ? null : Object.freeze({ kind: "plan_reject", reason: value });
  },
  (text) => {
    const value = match(/^\/plan\s+replace\s+([\s\S]+)$/u, text)?.[1];
    return value === undefined ? null : Object.freeze({ kind: "plan_replace", path: value });
  },
  (text) => text === "/retry" || text === "/continue"
    ? Object.freeze({ kind: "retry_or_continue", operation: text === "/retry" ? "retry" : "continue" })
    : null,
]);

export function parseTuiCommand(text: string): TuiParsedCommandV1 {
  for (const parser of TUI_COMMAND_PARSERS_V1) {
    const parsed = parser(text);
    if (parsed !== null) return parsed;
  }
  return Object.freeze({ kind: "text", text });
}
