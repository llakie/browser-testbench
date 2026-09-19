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
    const credential = {
      ...authorized,
      instanceId: "remote",
      instanceName: "windows",
      platform: "win32" as const,
      architecture: "x64",
      version: "0.1.8",
      url: "http://remote",
    };
    const headers = RemoteRequestSigner.headers(credential, "POST", "/v1/sessions", '{"target":"edge"}');
    const authentication = new RemoteRequestAuthentication(clients);

    const first = await authenticate(authentication, headers);
    expect(first.next).toHaveBeenCalledOnce();
    expect(authentication.principal(first.request)).toMatchObject({ clientId: authorized.clientId, role: "control" });
    const forbidden = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    expect(authentication.require(first.request, forbidden, "admin")).toBe(false);
    expect(forbidden.status).toHaveBeenCalledWith(403);

    const replay = await authenticate(authentication, headers);
    expect(replay.response.status).toHaveBeenCalledWith(401);
    expect(replay.next).not.toHaveBeenCalled();

    const tamperedHeaders = RemoteRequestSigner.headers(credential, "POST", "/v1/sessions", '{"target":"edge"}');
    const tampered = await authenticate(authentication, tamperedHeaders, { target: "firefox" });
    expect(tampered.response.status).toHaveBeenCalledWith(401);
    expect(tampered.next).not.toHaveBeenCalled();
  });

  it("authenticates signed loopback requests as their remote client", async () => {
    directory = await mkdtemp(join(tmpdir(), "browser-testbench-auth-"));
    const clients = new AuthorizedRemoteClientStore(join(directory, "clients.json"));
    const authorized = await clients.authorize("same-host-client", "control");
    const credential = {
      ...authorized,
      instanceId: "remote",
      instanceName: "windows",
      platform: "win32" as const,
      architecture: "x64",
      version: "0.1.8",
      url: "http://remote",
    };
    const headers = RemoteRequestSigner.headers(credential, "POST", "/v1/sessions", '{"target":"edge"}');
    const authentication = new RemoteRequestAuthentication(clients);

    const result = await authenticate(authentication, headers, { target: "edge" }, "127.0.0.1");

    expect(result.next).toHaveBeenCalledOnce();
    expect(authentication.principal(result.request)).toMatchObject({
      clientId: authorized.clientId,
      role: "control",
      local: false,
    });
  });
});

async function authenticate(
  authentication: RemoteRequestAuthentication,
  headers: Record<string, string>,
  body: object = { target: "edge" },
  remoteAddress = "192.168.1.12",
) {
  const request = {
    method: "POST",
    originalUrl: "/v1/sessions",
    body,
    socket: { remoteAddress },
    header: (name: string) => headers[name.toLowerCase()],
    is: () => false,
  } as unknown as Request;
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
  const next = vi.fn() as NextFunction;
  authentication.middleware(request, response, next);
  await vi.waitFor(() =>
    expect(next.mock.calls.length + (response.status as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1),
  );
  return { request, response: response as Response & { status: ReturnType<typeof vi.fn> }, next };
}
