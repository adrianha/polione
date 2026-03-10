import { Data } from "effect";

export class AppConfigError extends Data.TaggedError("AppConfigError")<{
  readonly message: string;
}> {}

export class AdapterError extends Data.TaggedError("AdapterError")<{
  readonly adapter: string;
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkflowError extends Data.TaggedError("WorkflowError")<{
  readonly workflow: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type AppError = AppConfigError | AdapterError | WorkflowError;
