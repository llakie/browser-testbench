import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class JsonFileStore<T> {
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly path: string,
    private readonly initial: () => T,
  ) {}

  async read(): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.initial();
      throw error;
    }
  }

  async write(value: T): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }

  update(change: (value: T) => T | void): Promise<void> {
    const operation = this.writes.then(async () => {
      const value = await this.read();
      await this.write(change(value) ?? value);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
}
