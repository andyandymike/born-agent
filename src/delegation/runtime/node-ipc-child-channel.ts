import type { DelegationChildControlChannelV1 } from "./child-approval-bridge.js";

export function nodeIpcDelegationChildChannel(): DelegationChildControlChannelV1 {
  return {
    get connected() { return process.connected === true; },
    send(frame) {
      if (process.send === undefined || process.connected !== true) {
        throw new Error("delegated child IPC channel is unavailable");
      }
      process.send(frame);
    },
    onMessage(listener) {
      const wrapped = (message: unknown) => listener(message);
      process.on("message", wrapped);
      return () => process.off("message", wrapped);
    },
    onClose(listener) {
      process.on("disconnect", listener);
      return () => process.off("disconnect", listener);
    },
  };
}
