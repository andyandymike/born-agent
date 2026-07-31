import type { OutcomeReport } from "../coordination/outcome-report.js";
import { OutcomeReportBuilder } from "../coordination/outcome-report.js";
import type { TaskStateProjection } from "../coordination/task-state-types.js";
import type { DecodedStoredEvent } from "../events/event-decoder-registry.js";
import { reconstructMultiRunSession } from "../sessions/reconstruct-multi-run-session.js";
import type { TuiPersistedEvent } from "./tui-event-reducer.js";

export interface Phase16TuiProjection {
  readonly outcomeReport: OutcomeReport;
  readonly taskState: TaskStateProjection;
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
        outcomeReport: this.#outcomes.build(session),
        taskState: session.taskState,
      };
    } catch (error) {
      if (this.#phase16) throw error;
      // Direct Phase 11 reducer tests use deliberately minimal event fixtures.
      // Real catalog/writer events are decoded strictly before reaching here.
      return null;
    }
  }
}
