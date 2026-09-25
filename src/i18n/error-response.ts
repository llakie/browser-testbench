import { Translator, type MessageDescriptor } from "./translator.js";

export interface ErrorResponsePayload {
  error?: string;
  message?: MessageDescriptor | string;
  code?: string;
  operation?: string;
  sessionId?: string;
  details?: Record<string, unknown>;
}

export class ErrorResponse {
  private static readonly english = new Translator("en");

  static describe(error: unknown): string {
    const messages = this.messages(error);
    return messages.length > 1
      ? `${messages[0]}\n${messages
          .slice(1)
          .map((message) => `- ${message}`)
          .join("\n")}`
      : messages[0]!;
  }

  static message(payload: ErrorResponsePayload, fallback: string): string {
    if (typeof payload.message === "string") return payload.message;
    return this.english.message(payload.message, payload.error ?? fallback);
  }

  private static messages(error: unknown): string[] {
    const message = error instanceof Error ? error.message : String(error);
    const nested =
      error instanceof AggregateError
        ? error.errors
        : error instanceof Error && error.cause !== undefined
          ? [error.cause]
          : [];
    return [message, ...nested.flatMap((cause) => this.messages(cause))].filter(
      (candidate, index, messages) => Boolean(candidate) && messages.indexOf(candidate) === index,
    );
  }
}
