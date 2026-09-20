import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRunner } from "../../src/infrastructure/command-runner.js";
import { IosSigningService } from "../../src/setup/ios-signing-service.js";

describe("IosSigningService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("extracts and deduplicates free and paid Apple Development teams", () => {
    expect(
      IosSigningService.parseIdentities(`
        1) ABC "Apple Development: Developer One (A1B2C3D4E5)"
        2) DEF "Apple Development: Developer One (A1B2C3D4E5)"
        3) GHI "iPhone Developer: Developer Two (F6G7H8I9J0)"
        2 valid identities found
      `),
    ).toEqual([
      { name: "Apple Development: Developer One", teamId: "A1B2C3D4E5" },
      { name: "iPhone Developer: Developer Two", teamId: "F6G7H8I9J0" },
    ]);
  });

  it("extracts the actual team ID from an Apple signing certificate subject", () => {
    expect(
      IosSigningService.parseCertificateTeamId(`UID=L782ZT3P93
CN=Apple Development: Developer One (A1B2C3D4E5)
OU=F6G7H8I9J0
O=Developer One
C=US`),
    ).toBe("F6G7H8I9J0");
  });

  it("explains an invalid certificate trust chain separately from a missing identity", async () => {
    vi.spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "0 valid identities found", stderr: "" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '1) ABC "Apple Development: Developer One (A1B2C3D4E5)"\n0 valid identities found',
        stderr: "",
      });

    await expect(IosSigningService.configuration({})).resolves.toMatchObject({
      problem: expect.stringContaining("Worldwide Developer Relations G3"),
    });
  });

  it("explains when an Apple Development certificate has no private key", async () => {
    vi.spyOn(CommandRunner, "run")
      .mockResolvedValueOnce({ code: 0, stdout: "0 valid identities found", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "0 identities found", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "-----BEGIN CERTIFICATE-----", stderr: "" });

    await expect(IosSigningService.configuration({})).resolves.toMatchObject({
      problem: expect.stringContaining("without its matching private key"),
    });
  });
});
