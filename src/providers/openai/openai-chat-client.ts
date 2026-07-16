import OpenAI from "openai";

import { ChatClientError } from "../../chat/errors.js";
import type {
  ChatClient,
  ChatRequest,
  ChatResponse,
} from "../../chat/types.js";
import { mapOpenAIError } from "./map-openai-error.js";

export interface OpenAIResponseLike {
  readonly _request_id?: string | null;
  readonly id: string;
  readonly model: string;
  readonly output_text: string;
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
  };
}

export interface OpenAISdkLike {
  readonly responses: {
    create(
      body: {
        readonly input: string;
        readonly instructions: string;
        readonly model: string;
        readonly store?: false;
      },
      options: {
        readonly signal: AbortSignal;
      },
    ): Promise<OpenAIResponseLike>;
  };
}

export interface OpenAISdkOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly maxRetries: number;
}

export interface OpenAIChatClientOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly includeStore?: boolean;
}

export type OpenAISdkFactory = (options: OpenAISdkOptions) => OpenAISdkLike;

const createOpenAISdk: OpenAISdkFactory = (options) => new OpenAI(options);

export class OpenAIChatClient implements ChatClient {
  private readonly client: OpenAISdkLike;
  private readonly includeStore: boolean;

  constructor(
    options: OpenAIChatClientOptions,
    factory: OpenAISdkFactory = createOpenAISdk,
  ) {
    this.client = factory({
      apiKey: options.apiKey,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      maxRetries: 0,
    });
    this.includeStore = options.includeStore ?? true;
  }

  async complete(
    request: ChatRequest,
    signal: AbortSignal,
  ): Promise<ChatResponse> {
    try {
      const response = await this.client.responses.create(
        {
          input: request.prompt,
          instructions: request.instructions,
          model: request.model,
          ...(this.includeStore ? { store: false as const } : {}),
        },
        { signal },
      );

      if (response.output_text.trim().length === 0) {
        throw new ChatClientError("protocol");
      }

      return {
        model: response.model,
        providerResponseId: response.id,
        text: response.output_text,
        ...(response.usage === undefined
          ? {}
          : {
              usage: {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                totalTokens: response.usage.total_tokens,
              },
            }),
      };
    } catch (error) {
      if (error instanceof ChatClientError) {
        throw error;
      }
      throw mapOpenAIError(error);
    }
  }
}
