import type { ProviderId } from "../model/model-backend.js";

export type CredentialVariable =
  | "ANTHROPIC_API_KEY"
  | "OPENAI_API_KEY";

export class CredentialHandle {
  readonly variableName: CredentialVariable;
  readonly #secret: string;

  constructor(variableName: CredentialVariable, secret: string) {
    this.variableName = variableName;
    this.#secret = secret;
  }

  reveal(): string {
    return this.#secret;
  }

  toJSON(): string {
    return "[credential handle]";
  }

  toString(): string {
    return "[credential handle]";
  }
}

export type CredentialResolution =
  | {
      readonly credential: CredentialHandle;
      readonly status: "configured";
      readonly variableName: CredentialVariable;
    }
  | {
      readonly status: "missing";
      readonly variableName: CredentialVariable;
    }
  | {
      readonly status: "not_required";
      readonly variableName: null;
    };

const PROVIDER_CREDENTIALS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
} as const satisfies Partial<Record<ProviderId, CredentialVariable>>;

export class CredentialResolver {
  constructor(
    private readonly environment: Readonly<
      Record<string, string | undefined>
    >,
  ) {}

  resolve(provider: ProviderId): CredentialResolution {
    if (provider === "ollama") {
      return { status: "not_required", variableName: null };
    }

    const variableName = PROVIDER_CREDENTIALS[provider];
    // PHASE8: resolve exactly one named variable so an adapter never receives
    // another provider's key or an ambient process.env capability.
    const value = this.environment[variableName]?.trim();
    return value === undefined || value.length === 0
      ? { status: "missing", variableName }
      : {
          credential: new CredentialHandle(variableName, value),
          status: "configured",
          variableName,
        };
  }
}
