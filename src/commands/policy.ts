import type { CliIO, CliRuntime } from "../cli/types.js";
import { loadRuntimePolicyRegistry } from "../policy/policy-config-loader.js";
import { RuntimePolicyError } from "../policy/policy-errors.js";
import {
  resolveEffectiveRuntimePolicy,
  resolveProviderPolicyRequest,
  assertEvalAccess,
} from "../policy/policy-resolver.js";
import {
  registryValidationDocument,
  renderRuntimePolicy,
  runtimePolicyDocument,
} from "../policy/policy-renderer.js";
import type { EvalSuiteAccess } from "../policy/runtime-policy-schema.js";

interface PolicyBaseOptions {
  readonly config?: string | undefined;
  readonly json: boolean;
}

export interface PolicyShowOptions extends PolicyBaseOptions {
  readonly profile?: string | undefined;
}

export interface PolicyExplainOptions extends PolicyBaseOptions {
  readonly profile: string;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly suite?: string | undefined;
}

function failure(error: unknown, io: CliIO): 1 | 2 {
  if (error instanceof RuntimePolicyError) {
    io.stderr.write(`runtime policy error: ${error.message}\n`);
    return error.exitCode;
  }
  io.stderr.write("runtime policy internal error\n");
  return 1;
}

async function registry(options: PolicyBaseOptions, runtime: CliRuntime) {
  return loadRuntimePolicyRegistry({
    ...(options.config === undefined ? {} : { configPath: options.config }),
    env: runtime.env,
    platform: runtime.platform,
    workspace: runtime.cwd,
  });
}

export async function executePolicyShow(
  options: PolicyShowOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2> {
  try {
    const effective = resolveEffectiveRuntimePolicy(
      await registry(options, runtime),
      options.profile,
    );
    io.stdout.write(options.json
      ? `${JSON.stringify(runtimePolicyDocument(effective), null, 2)}\n`
      : renderRuntimePolicy(effective));
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}

export async function executePolicyValidate(
  options: PolicyBaseOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2> {
  try {
    const document = registryValidationDocument((await registry(options, runtime)).list());
    if (options.json) {
      io.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    } else {
      io.stdout.write(`Runtime policy config valid: ${String((document.profiles as readonly unknown[]).length)} profile(s)\n`);
      for (const profile of document.profiles as readonly Record<string, unknown>[]) {
        io.stdout.write(`${String(profile.id)}  ${String(profile.mode)}  ${String(profile.source)}  ${String(profile.sha256)}\n`);
      }
    }
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}

export async function executePolicyExplain(
  options: PolicyExplainOptions,
  runtime: CliRuntime,
  io: CliIO,
): Promise<0 | 1 | 2> {
  try {
    const effective = resolveEffectiveRuntimePolicy(
      await registry(options, runtime),
      options.profile,
    );
    const provider = resolveProviderPolicyRequest(effective, {
      endpoint: options.endpoint,
      model: options.model,
      provider: options.provider,
    });
    if (options.suite !== undefined) {
      if (!(["targeted", "smoke", "full"] as const).includes(options.suite as EvalSuiteAccess)) {
        throw new RuntimePolicyError("policy_eval_suite_denied", "suite must be targeted, smoke, or full");
      }
      assertEvalAccess({ attempts: 1, policy: effective, suite: options.suite as EvalSuiteAccess });
    }
    const document = {
      schemaVersion: 1,
      allowed: true,
      profile: runtimePolicyDocument(effective),
      request: provider,
      evalSuite: options.suite ?? null,
      sideEffects: {
        credentialReads: 0,
        backendConstructions: 0,
        providerRequests: 0,
        dockerCalls: 0,
      },
    } as const;
    io.stdout.write(options.json
      ? `${JSON.stringify(document, null, 2)}\n`
      : [
          `Decision: allow`,
          `Profile:  ${effective.entry.profile.id} (${effective.entry.profileSha256})`,
          `Request:  ${provider.provider}/${provider.model}`,
          `Endpoint: ${provider.endpoint ?? "none"}`,
          `Suite:    ${options.suite ?? "none"}`,
          "Side effects: 0 credential / 0 backend / 0 request / 0 Docker",
          "",
        ].join("\n"));
    return 0;
  } catch (error) {
    return failure(error, io);
  }
}
