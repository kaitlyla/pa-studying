/** A broken content invariant; the build fails naming the offending id (40 §40.1). */
export class BuildError extends Error {
  readonly id: string;

  constructor(id: string, message: string) {
    super(`${id}: ${message}`);
    this.name = "BuildError";
    this.id = id;
  }
}
