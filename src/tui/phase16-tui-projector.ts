import type { OutcomeReport } from "../coordination/outcome-report.js";
import { OutcomeReportBuilder } from "../coordination/outcome-report.js";
import type { TaskStateProjection } from "../coordination/task-state-types.js";
import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import type { TuiPersistedEvent } from "./tui-event-reducer.js";
import type { TaskGraphProjectionV1 } from "../task-graph/task-graph-projector.js";
import type { TaskExecutionProjectionV1 } from "../scheduling/task-execution-projector.js";
import type { WorktreeProjectionV1 } from "../worktrees/worktree-projector.js";
import type { BackgroundProjectionV1 } from "../background/background-projector.js";

export interface Phase16TuiProjection {
  readonly background: BackgroundProjectionV1;
  readonly outcomeReport: OutcomeReport;
  readonly taskExecution: TaskExecutionProjectionV1 | null;
  readonly taskGraph: TaskGraphProjectionV1;
  readonly taskState: TaskStateProjection;
  readonly worktrees: WorktreeProjectionV1;
}

function decoded(event: TuiPersistedEvent): DecodedStoredEvent {
  if (event.sourceSchemaVersion !== 1 && event.sourceSchemaVersion !== 2) {
    throw new TypeError("Phase 16 TUI projection requires a decoded event");
  }
  return event as DecodedStoredEvent;
}

export class Phase16TuiProjector {
  readonly #events: DecodedStoredEvent[] = [];
  readonly #outcomes = new OutcomeReportBuilder();
  #phase16 = false;

  reset(): void {
    this.#events.length = 0;
    this.#phase16 = false;
  }

  accept(event: TuiPersistedEvent): Phase16TuiProjection | null {
    this.#events.push(decoded(event));
    this.#phase16 ||=
      event.type === "goal.created" ||
      event.type === "goal.revised" ||
      event.type === "goal.status.changed" ||
      event.type === "plan.approved" ||
      event.type === "plan.completed" ||
      event.type === "plan.item.status_changed" ||
      event.type === "plan.proposed" ||
      event.type === "plan.rejected" ||
      event.type === "plan.revised";
    try {
      const session = reconstructMultiRunSession(this.#events);
      return {
        background: session.background,
        outcomeReport: this.#outcomes.build(session),
        taskExecution: session.taskExecution,
        taskGraph: session.taskGraph,
        taskState: session.taskState,
        worktrees: session.worktrees,
      };
    } catch (error) {
      if (this.#phase16) throw error;
      // Direct Phase 11 reducer tests use deliberately minimal event fixtures.
      // Real catalog/writer events are decoded strictly before reaching here.
      return null;
    }
  }
}
