import { describe, expect, it } from "vitest";
import {
  adapterError,
  appConfigError,
  isAppError,
  toErrorMessage,
  workflowError,
} from "../src/app/errors.js";

describe("app errors", () => {
  it("builds tagged app config errors", () => {
    const err = appConfigError("missing config");
    expect(err._tag).toBe("AppConfigError");
    expect(err.message).toBe("missing config");
    expect(isAppError(err)).toBe(true);
  });

  it("maps adapter/workflow errors with default message", () => {
    const cause = new Error("boom");
    const adapter = adapterError({ adapter: "clob", operation: "placeOrder", cause });
    const workflow = workflowError({ workflow: "entry", cause });

    expect(adapter._tag).toBe("AdapterError");
    expect(adapter.message).toBe("boom");
    expect(adapter.adapter).toBe("clob");
    expect(workflow._tag).toBe("WorkflowError");
    expect(workflow.message).toBe("boom");
    expect(workflow.workflow).toBe("entry");
  });

  it("normalizes unknown causes to messages", () => {
    expect(toErrorMessage("oops")).toBe("oops");
    expect(toErrorMessage({ a: 1 })).toBe('{"a":1}');
    expect(toErrorMessage(undefined)).toBe("undefined");
    expect(isAppError(new Error("not app"))).toBe(false);
  });
});
