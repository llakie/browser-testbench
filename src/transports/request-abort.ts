import type { Request, Response } from "express";

export class RequestAbort {
  static signal(request: Request, response: Response): AbortSignal {
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    return controller.signal;
  }
}
