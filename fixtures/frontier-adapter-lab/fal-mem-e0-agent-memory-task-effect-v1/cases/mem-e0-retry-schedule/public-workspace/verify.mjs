import { retrySchedule } from "./src/retry-schedule.mjs";

const schedule = retrySchedule();
if (
  !Array.isArray(schedule) ||
  schedule.length < 2 ||
  !Object.isFrozen(schedule) ||
  schedule.some((value) => !Number.isInteger(value) || value <= 0)
) {
  console.error("retry schedule must be a frozen array of positive integers");
  process.exit(1);
}
console.log("MEM-E0 public shape pass: retry schedule");
