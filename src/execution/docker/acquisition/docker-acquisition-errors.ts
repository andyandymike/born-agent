export class DockerAcquisitionError extends Error {
  override readonly name = "DockerAcquisitionError";

  public constructor(
    readonly code: string,
    message: string,
    readonly exitCode: 1 | 2 | 3 | 5,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}
