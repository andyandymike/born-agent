import { sha256Canonical } from "../../completion/canonical-json.js";
import {
  revalidateBackgroundExecutable,
  sealBackgroundExecutable,
  type SealedBackgroundExecutableV1,
} from "../../background/background-executable-descriptor.js";

export interface DelegationChildExecutableDescriptorV1 {
  readonly runtimeExecutablePath: string;
  readonly runtimeExecutableSha256: string;
  readonly productEntrypointPath: string;
  readonly productEntrypointSha256: string;
  readonly packageVersion: string;
  readonly protocolVersion: 1;
  readonly descriptorSha256: string;
}

export interface SealedDelegationChildExecutableV1 {
  readonly descriptor: DelegationChildExecutableDescriptorV1;
  readonly sealed: SealedBackgroundExecutableV1;
}

export async function sealDelegationChildExecutable(input: {
  readonly cliEntryPath: string;
  readonly nodeExecutablePath: string;
  readonly nodeVersion: string;
}): Promise<SealedDelegationChildExecutableV1> {
  const sealed = await sealBackgroundExecutable(input);
  const content = {
    runtimeExecutablePath: sealed.nodeExecutablePath,
    runtimeExecutableSha256: sealed.descriptor.nodeExecutableSha256,
    productEntrypointPath: sealed.cliEntryPath,
    productEntrypointSha256: sealed.descriptor.cliEntrySha256,
    packageVersion: sealed.descriptor.packageVersion,
    protocolVersion: 1 as const,
  };
  return Object.freeze({
    descriptor: Object.freeze({ ...content, descriptorSha256: sha256Canonical(content) }),
    sealed,
  });
}

export async function revalidateDelegationChildExecutable(
  value: SealedDelegationChildExecutableV1,
): Promise<void> {
  await revalidateBackgroundExecutable(value.sealed);
  const current = await sealDelegationChildExecutable({
    cliEntryPath: value.sealed.cliEntryPath,
    nodeExecutablePath: value.sealed.nodeExecutablePath,
    nodeVersion: value.sealed.descriptor.nodeVersion,
  });
  if (current.descriptor.descriptorSha256 !== value.descriptor.descriptorSha256) {
    throw new Error("sealed delegated child executable changed before launch");
  }
}
