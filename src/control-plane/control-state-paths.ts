import { chmod, lstat, mkdir, realpath, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import { sha256Canonical } from "../completion/canonical-json.js";
import { ApplicationControlError } from "./application-errors.js";

function platformPath(value: string): string {
  const normalized = value.normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contained(root: string, candidate: string): boolean {
  const rootKey = platformPath(root);
  const candidateKey = platformPath(candidate);
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${sep}`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ApplicationControlError("control_identity_corrupt", "control state path is not a real directory");
  }
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export class ControlStatePaths {
  readonly artifactObjects: string;
  readonly artifactRecords: string;
  readonly catalogRoot: string;
  readonly controlRoot: string;
  readonly cursorRoot: string;
  readonly hostIdentityPath: string;
  readonly integrityKeyPath: string;
  readonly localPrincipalPath: string;
  readonly lockRoot: string;
  readonly operationRoot: string;
  readonly prepareRoot: string;
  readonly repositoryRoot: string;
  readonly sessionCatalogRoot: string;
  readonly stateRoot: string;
  readonly stateRootIdentitySha256: string;
  readonly temporaryRoot: string;

  private constructor(input: {
    readonly controlRoot: string;
    readonly stateRoot: string;
    readonly stateRootIdentitySha256: string;
  }) {
    this.stateRoot = input.stateRoot;
    this.stateRootIdentitySha256 = input.stateRootIdentitySha256;
    this.controlRoot = input.controlRoot;
    this.hostIdentityPath = join(this.controlRoot, "host-control-identity.v1.json");
    this.localPrincipalPath = join(this.controlRoot, "local-owner-principal.v1.json");
    this.integrityKeyPath = join(this.controlRoot, "control-integrity-key.v1.bin");
    this.temporaryRoot = join(this.controlRoot, "temporary");
    this.lockRoot = join(this.controlRoot, "locks");
    this.operationRoot = join(this.controlRoot, "operations");
    this.prepareRoot = join(this.controlRoot, "prepared-actions");
    this.catalogRoot = join(this.controlRoot, "catalogs");
    this.repositoryRoot = join(this.catalogRoot, "repositories");
    this.sessionCatalogRoot = join(this.catalogRoot, "sessions");
    this.artifactRecords = join(this.controlRoot, "artifacts", "records");
    this.artifactObjects = join(this.controlRoot, "artifacts", "objects");
    this.cursorRoot = join(this.controlRoot, "pagination-cursors");
  }

  static async create(root: string): Promise<ControlStatePaths> {
    if (!isAbsolute(root)) {
      throw new ApplicationControlError("control_identity_corrupt", "control state root must be absolute");
    }
    const requested = resolve(root);
    await ensurePrivateDirectory(requested);
    const stateRoot = await realpath(requested);
    const metadata = await lstat(stateRoot);
    const controlRoot = join(stateRoot, "control-plane", "v1");
    const paths = new ControlStatePaths({
      controlRoot,
      stateRoot,
      stateRootIdentitySha256: sha256Canonical({
        dev: metadata.dev,
        ino: metadata.ino,
        real_path: platformPath(stateRoot),
        schema_version: 1,
      }),
    });
    for (const directory of [
      paths.controlRoot,
      paths.temporaryRoot,
      paths.lockRoot,
      paths.operationRoot,
      paths.prepareRoot,
      paths.catalogRoot,
      paths.repositoryRoot,
      paths.sessionCatalogRoot,
      paths.artifactRecords,
      paths.artifactObjects,
      paths.cursorRoot,
    ]) {
      if (!contained(paths.controlRoot, directory)) {
        throw new ApplicationControlError("control_identity_corrupt", "control state path escaped its root");
      }
      await ensurePrivateDirectory(directory);
      if (!contained(await realpath(paths.controlRoot), await realpath(directory))) {
        throw new ApplicationControlError("control_identity_corrupt", "control state directory escaped through a link or junction");
      }
    }
    return paths;
  }

  async assertSafe(path: string): Promise<void> {
    const resolved = resolve(path);
    if (!contained(this.controlRoot, resolved)) {
      throw new ApplicationControlError("control_identity_corrupt", "control state path escaped its root");
    }
    const parent = resolve(path, "..");
    const parentMetadata = await lstat(parent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw new ApplicationControlError("control_identity_corrupt", "control state parent is unsafe");
    }
    if (!contained(this.controlRoot, await realpath(parent))) {
      throw new ApplicationControlError("control_identity_corrupt", "control state parent escaped its root");
    }
  }

  async hasAuthorityRecords(): Promise<boolean> {
    for (const directory of [
      this.operationRoot,
      this.prepareRoot,
      this.repositoryRoot,
      this.sessionCatalogRoot,
      this.artifactRecords,
      this.cursorRoot,
    ]) {
      if ((await readdir(directory)).length > 0) return true;
    }
    return false;
  }
}
