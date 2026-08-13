import { sha256Canonical } from "../completion/canonical-json.js";
import type { ChatExecutionPortV1 } from "./use-cases/session-message-action.js";
import type { SessionResumeOwnerPortV1 } from "./use-cases/session-resume-action.js";
import type { Phase21ALocalControlPlane } from "./local-control-plane.js";
import { ActiveOwnerRouter } from "./active-owner-router.js";
import { SessionDeliveryCoordinator } from "./delivery-cursor.js";
import { ApplicationControlError } from "./application-errors.js";
import { SessionOwnerBroker } from "./session-owner-broker.js";

interface DynamicOwnerEntryV1<TPort> {
  readonly port: TPort;
  readonly registrationId: symbol;
}

class DynamicChatExecutionRouter implements ChatExecutionPortV1 {
  private disposed = false;
  private readonly entries = new Map<string, DynamicOwnerEntryV1<ChatExecutionPortV1>>();

  register(payloadSha256: string, port: ChatExecutionPortV1): () => void {
    if (this.disposed) throw new ApplicationControlError("control_operation_busy", "application Host is disposed");
    if (this.entries.has(payloadSha256)) {
      throw new ApplicationControlError("control_operation_busy", "the exact Chat execution is already registered");
    }
    const entry = Object.freeze({ port, registrationId: Symbol(payloadSha256) });
    this.entries.set(payloadSha256, entry);
    return () => {
      if (this.entries.get(payloadSha256) === entry) this.entries.delete(payloadSha256);
    };
  }

  async execute(input: Parameters<ChatExecutionPortV1["execute"]>[0]) {
    const payloadSha256 = sha256Canonical(input.payload);
    const entry = this.entries.get(payloadSha256);
    if (entry === undefined) {
      throw new ApplicationControlError("control_operation_busy", "the exact Chat execution owner is unavailable");
    }
    try {
      return await entry.port.execute(input);
    } finally {
      if (this.entries.get(payloadSha256) === entry) this.entries.delete(payloadSha256);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

class DynamicSessionResumeOwnerRouter implements SessionResumeOwnerPortV1 {
  private disposed = false;
  private readonly entries = new Map<string, DynamicOwnerEntryV1<SessionResumeOwnerPortV1>>();

  register(sessionId: string, port: SessionResumeOwnerPortV1): () => void {
    if (this.disposed) throw new ApplicationControlError("control_operation_busy", "application Host is disposed");
    if (this.entries.has(sessionId)) {
      throw new ApplicationControlError("control_operation_busy", "the exact session resume owner is already registered");
    }
    const entry = Object.freeze({ port, registrationId: Symbol(sessionId) });
    this.entries.set(sessionId, entry);
    return () => {
      if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
    };
  }

  async execute(input: Parameters<SessionResumeOwnerPortV1["execute"]>[0]) {
    const entry = this.entries.get(input.sessionId);
    if (entry === undefined) {
      throw new ApplicationControlError("control_operation_busy", "the exact session resume owner is unavailable");
    }
    try {
      return await entry.port.execute(input);
    } finally {
      if (this.entries.get(input.sessionId) === entry) this.entries.delete(input.sessionId);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface LocalApplicationHostConstructionV1 {
  readonly activeOwners: ActiveOwnerRouter;
  readonly broker: SessionOwnerBroker;
  readonly chatExecution: ChatExecutionPortV1;
  readonly delivery: SessionDeliveryCoordinator;
  readonly sessionResumeOwner: SessionResumeOwnerPortV1;
}

export class LocalApplicationHost {
  private disposed = false;
  private disposeCountValue = 0;

  private constructor(
    readonly stateRoot: string,
    readonly plane: Phase21ALocalControlPlane,
    readonly activeOwners: ActiveOwnerRouter,
    readonly broker: SessionOwnerBroker,
    readonly delivery: SessionDeliveryCoordinator,
    private readonly chatExecutions: DynamicChatExecutionRouter,
    private readonly resumeOwners: DynamicSessionResumeOwnerRouter,
  ) {}

  static async create(input: Readonly<{
    readonly createPlane: (construction: LocalApplicationHostConstructionV1) => Promise<Phase21ALocalControlPlane>;
    readonly stateRoot: string;
  }>): Promise<LocalApplicationHost> {
    const activeOwners = new ActiveOwnerRouter(input.stateRoot);
    const broker = new SessionOwnerBroker();
    const delivery = new SessionDeliveryCoordinator();
    const chatExecutions = new DynamicChatExecutionRouter();
    const resumeOwners = new DynamicSessionResumeOwnerRouter();
    try {
      const plane = await input.createPlane(Object.freeze({
        activeOwners,
        broker,
        chatExecution: chatExecutions,
        delivery,
        sessionResumeOwner: resumeOwners,
      }));
      return new LocalApplicationHost(
        input.stateRoot,
        plane,
        activeOwners,
        broker,
        delivery,
        chatExecutions,
        resumeOwners,
      );
    } catch (error) {
      activeOwners.dispose();
      broker.dispose();
      delivery.dispose();
      chatExecutions.dispose();
      resumeOwners.dispose();
      throw error;
    }
  }

  registerChatExecution(payloadSha256: string, port: ChatExecutionPortV1): () => void {
    this.assertActive();
    return this.chatExecutions.register(payloadSha256, port);
  }

  registerSessionResumeOwner(sessionId: string, port: SessionResumeOwnerPortV1): () => void {
    this.assertActive();
    return this.resumeOwners.register(sessionId, port);
  }

  get disposeCount(): number {
    return this.disposeCountValue;
  }

  get ephemeralOwnerCount(): number {
    return this.chatExecutions.size + this.resumeOwners.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeCountValue += 1;
    this.chatExecutions.dispose();
    this.resumeOwners.dispose();
    this.activeOwners.dispose();
    this.broker.dispose();
    this.delivery.dispose();
  }

  private assertActive(): void {
    if (this.disposed) throw new ApplicationControlError("control_operation_busy", "application Host is disposed");
  }
}

export class ProcessLocalApplicationHostRegistry {
  private readonly hosts = new Map<string, Promise<LocalApplicationHost>>();
  private readonly resolved = new Map<string, LocalApplicationHost>();

  get size(): number {
    return this.hosts.size;
  }

  peek(stateRoot: string): LocalApplicationHost | null {
    return this.resolved.get(stateRoot) ?? null;
  }

  async getOrCreate(input: Readonly<{
    readonly createPlane: (construction: LocalApplicationHostConstructionV1) => Promise<Phase21ALocalControlPlane>;
    readonly stateRoot: string;
  }>): Promise<LocalApplicationHost> {
    const existing = this.hosts.get(input.stateRoot);
    if (existing !== undefined) return existing;
    const created = LocalApplicationHost.create(input);
    this.hosts.set(input.stateRoot, created);
    try {
      const host = await created;
      if (this.hosts.get(input.stateRoot) === created) this.resolved.set(input.stateRoot, host);
      return host;
    } catch (error) {
      if (this.hosts.get(input.stateRoot) === created) this.hosts.delete(input.stateRoot);
      this.resolved.delete(input.stateRoot);
      throw error;
    }
  }

  async dispose(stateRoot: string): Promise<void> {
    const pending = this.hosts.get(stateRoot);
    if (pending === undefined) return;
    this.hosts.delete(stateRoot);
    this.resolved.delete(stateRoot);
    (await pending).dispose();
  }

  async disposeAll(): Promise<void> {
    const pending = [...this.hosts.values()];
    this.hosts.clear();
    this.resolved.clear();
    for (const host of await Promise.all(pending)) host.dispose();
  }
}

export const processLocalApplicationHosts = new ProcessLocalApplicationHostRegistry();
