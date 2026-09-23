import { Translator, type MessageDescriptor } from "./translator.js";

export interface ErrorResponsePayload {
  error?: string;
  message?: MessageDescriptor;
  code?: string;
}

export class ErrorResponse {
  private static readonly english = new Translator("en");

  static message(payload: ErrorResponsePayload, fallback: string): string {
    return this.english.message(payload.message, payload.error ?? fallback);
  }
}
