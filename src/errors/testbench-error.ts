export type TestbenchErrorDetails = Record<string, unknown>;

export interface TestbenchErrorOptions {
  operation: string;
  sessionId?: string;
  details?: TestbenchErrorDetails;
  status?: number;
  cause?: unknown;
}

export interface TestbenchErrorPayload {
  code: string;
  message: string;
  error: string;
  operation: string;
  sessionId?: string;
  details: TestbenchErrorDetails;
}

export class TestbenchError extends Error {
  readonly details: TestbenchErrorDetails;
  readonly operation: string;
  readonly sessionId?: string;
  readonly status: number;

  constructor(
    readonly code: string,
    message: string,
    options: TestbenchErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TestbenchError";
    this.operation = options.operation;
    this.sessionId = options.sessionId;
    this.details = options.details ?? {};
    this.status = options.status ?? 500;
  }

  toPayload(): TestbenchErrorPayload {
    return {
      code: this.code,
      message: this.message,
      error: this.message,
      operation: this.operation,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      details: this.details,
    };
  }
}
