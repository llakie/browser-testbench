import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { AuthorizedRemoteClientStore } from "../../src/remote/remote-client-store.js";
import { RemoteRequestAuthentication, RemoteRequestSigner } from "../../src/remote/remote-request-authentication.js";

describe("RemoteRequestAuthentication", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("authenticates a signed request once and rejects replay", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-auth-"));
    const clients = new AuthorizedRemoteClientStore(join(directory, "clients.json"));
    const authorized = await clients.authorize("developer-mac", "control");
    const credential = { ...authorized, instanceId: "remote", instanceName: "windows", url: "http://remote" };
    const headers = RemoteRequestSigner.headers(credential, "POST", "/v1/sessions", '{"target":"edge"}');
    const authentication = new RemoteRequestAuthentication(clients);

    const first = await authenticate(authentication, headers);
    expect(first.next).toHaveBeenCalledOnce();
    expect(authentication.principal(first.request)).toMatchObject({ clientId: authorized.clientId, role: "control" });

    const replay = await authenticate(authentication, headers);
    expect(replay.response.status).toHaveBeenCalledWith(401);
    expect(replay.next).not.toHaveBeenCalled();
  });
});

async function authenticate(authentication: RemoteRequestAuthentication, headers: Record<string, string>) {
  const request = {
    method: "POST",
    originalUrl: "/v1/sessions",
    body: { target: "edge" },
    socket: { remoteAddress: "192.168.1.12" },
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
  const next = vi.fn() as NextFunction;
  authentication.middleware(request, response, next);
  await vi.waitFor(() =>
    expect(next.mock.calls.length + (response.status as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1),
  );
  return { request, response: response as Response & { status: ReturnType<typeof vi.fn> }, next };
}
