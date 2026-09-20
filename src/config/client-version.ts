import { PackageMetadata } from "./package-metadata.js";

export class ClientVersion {
  static readonly HEADER = "x-browser-testbench-version";
  static readonly CURRENT = PackageMetadata.VERSION;

  static headers(headers?: HeadersInit): Headers {
    const result = new Headers(headers);
    result.set(this.HEADER, this.CURRENT);
    return result;
  }
}
