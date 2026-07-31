import { canonicalJson } from "../completion/canonical-json.js";
import type { DecodedSessionEvent } from "../events/event-decoder-registry.js";
import type { PlanItemStatus } from "./plan-schema.js";
import type { UpdatePlanInput } from "./update-plan-input-schema.js";

export interface PlanToolObservation {
  readonly code: string;
  readonly item_id: string | null;
  readonly item_status: PlanItemStatus | null;
  readonly message: string;
  readonly operation: UpdatePlanInput["operation"];
  readonly plan_id: string | null;
  readonly plan_sha256: string | null;
  readonly requires_user_approval: boolean;
  readonly revision: number | null;
  readonly status: "applied" | "rejected";
}

function boundedMessage(message: string): string {
  let result = "";
  let bytes = 0;
  for (const character of message.replace(/[\r\n\t]+/gu, " ")) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > 1_024) break;
    result += character;
    bytes += size;
  }
  return result;
}

export function rejectedPlanObservation(
  operation: UpdatePlanInput["operation"],
  code: string,
  message: string,
): PlanToolObservation {
  return Object.freeze({
    code,
    item_id: null,
    item_status: null,
    message: boundedMessage(message),
    operation,
    plan_id: null,
    plan_sha256: null,
    requires_user_approval: false,
    revision: null,
    status: "rejected",
  });
}

export function appliedPlanObservation(
  operation: UpdatePlanInput["operation"],
  event: Extract<
    DecodedSessionEvent,
    {
      type:
        | "plan.item.status_changed"
        | "plan.proposed"
        | "plan.revised";
    }
  >,
): PlanToolObservation {
  if (event.type === "plan.item.status_changed") {
    return Object.freeze({
      code: "plan_item_status_applied",
      item_id: event.data.item_id,
      item_status: event.data.to,
      message: boundedMessage("Plan item progress was recorded durably."),
      operation,
      plan_id: event.data.plan_id,
      plan_sha256: event.data.plan_sha256,
      requires_user_approval: false,
      revision: event.data.revision,
      status: "applied",
    });
  }
  return Object.freeze({
    code:
      event.type === "plan.proposed"
        ? "plan_proposed"
        : "plan_revision_proposed",
    item_id: null,
    item_status: null,
    message: boundedMessage(
      "A draft Plan revision was recorded and requires exact user approval before it becomes execution authority.",
    ),
    operation,
    plan_id: event.data.content.planId,
    plan_sha256: event.data.plan_sha256,
    requires_user_approval: true,
    revision: event.data.content.revision,
    status: "applied",
  });
}

export function renderPlanToolObservation(
  observation: PlanToolObservation,
): string {
  return canonicalJson(observation);
}
