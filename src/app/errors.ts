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

export const toErrorMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }

  if (typeof cause === "string") {
    return cause;
  }

  if (cause === undefined) {
    return "undefined";
  }

  if (cause === null) {
    return "null";
  }

  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
};

export const appConfigError = (message: string): AppConfigError => new AppConfigError({ message });

export const adapterError = (params: {
  adapter: string;
  operation: string;
  cause?: unknown;
  message?: string;
}): AdapterError =>
  new AdapterError({
    adapter: params.adapter,
    operation: params.operation,
    cause: params.cause,
    message: params.message ?? toErrorMessage(params.cause),
  });

export const workflowError = (params: { workflow: string; cause?: unknown; message?: string }): WorkflowError =>
  new WorkflowError({
    workflow: params.workflow,
    cause: params.cause,
    message: params.message ?? toErrorMessage(params.cause),
  });

export const isAppError = (error: unknown): error is AppError => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const tag = (error as { _tag?: unknown })._tag;
  return tag === "AppConfigError" || tag === "AdapterError" || tag === "WorkflowError";
};
