export interface ApplicationHostRuntimeV1 {
  readonly now: () => Date;
  readonly wait: (delayMs: number) => Promise<void>;
  readonly startRecurringTask: (
    intervalMs: number,
    task: () => Promise<void>,
  ) => () => Promise<void>;
}

export type ApplicationRecurringTaskPortV1 = Pick<ApplicationHostRuntimeV1, "startRecurringTask">;

/**
 * PHASE21: only the Host composition adapter may consult the process clock or
 * schedule OS timers. Application/query services receive this narrow port so
 * replay, tests, and future controllers never acquire ambient process
 * authority merely by importing the service implementation.
 */
export function createNodeApplicationHostRuntime(): ApplicationHostRuntimeV1 {
  return Object.freeze({
    now: () => new Date(),
    wait: (delayMs: number) => new Promise<void>((resolve) => { setTimeout(resolve, delayMs); }),
    startRecurringTask: (intervalMs: number, task: () => Promise<void>) => {
      let stopped = false;
      let pending = Promise.resolve();
      const timer = setInterval(() => {
        pending = pending
          .then(async () => {
            if (!stopped) await task();
          })
          .catch(() => undefined);
      }, intervalMs);
      timer.unref();
      return async () => {
        stopped = true;
        clearInterval(timer);
        await pending;
      };
    },
  });
}
