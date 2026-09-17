import { watch, type FSWatcher } from "node:fs";

const CHANGE_DEBOUNCE_MS = 50;

export class UiLiveReload {
  private readonly listeners = new Set<() => void>();
  private readonly watchers: FSWatcher[] = [];
  private changeTimer?: NodeJS.Timeout;

  constructor(private readonly directories: string[]) {}

  start(): void {
    if (this.watchers.length > 0) return;
    for (const directory of this.directories) {
      this.watchers.push(watch(directory, { recursive: true }, () => this.scheduleReload()));
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    for (const watcher of this.watchers.splice(0)) watcher.close();
    this.listeners.clear();
  }

  private scheduleReload(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      for (const listener of this.listeners) listener();
    }, CHANGE_DEBOUNCE_MS);
  }
}
