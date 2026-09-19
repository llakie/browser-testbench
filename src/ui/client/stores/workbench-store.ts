import { reactive } from "vue";
import type { ConnectionStatus } from "../../../remote/remote-types.js";
import type { WorkbenchState } from "../../../setup/workbench-types.js";
import { ApiClient } from "../core/api-client.js";
import { EventStream } from "../core/event-stream.js";

const refreshDelayMs = 250;

export interface VerificationState {
  status: "running" | "passed" | "failed";
  message: string;
}

interface NoticeState {
  message: string;
  kind: string;
}

interface StoreState {
  workbench: WorkbenchState | null;
  connection: ConnectionStatus;
  loading: boolean;
  analyzing: boolean;
  busy: boolean;
  notice: NoticeState | null;
  verification: Record<string, VerificationState>;
}

export class WorkbenchStore {
  readonly state = reactive<StoreState>({
    workbench: null,
    connection: { mode: "local", reachable: true },
    loading: false,
    analyzing: false,
    busy: false,
    notice: null,
    verification: {},
  });

  private refreshTimer?: ReturnType<typeof setTimeout>;
  private loadWorkbench = false;
  private readonly events = new EventStream(() => this.scheduleRefresh());

  get workbench(): WorkbenchState | null {
    return this.state.workbench;
  }

  get connection(): ConnectionStatus {
    return this.state.connection;
  }

  get loading(): boolean {
    return this.state.loading;
  }

  get analyzing(): boolean {
    return this.state.analyzing;
  }

  get busy(): boolean {
    return this.state.busy;
  }

  async initialize(loadWorkbench: boolean): Promise<void> {
    this.loadWorkbench = loadWorkbench;
    this.events.start();
    if (loadWorkbench) await this.refresh({ analyze: true });
    else await this.refreshConnection();
  }

  async refresh({ analyze = false, background = false } = {}): Promise<void> {
    if (!this.loadWorkbench) return this.refreshConnection();
    if (!background) {
      this.state.loading = true;
      this.state.analyzing = analyze;
    }
    try {
      const workbench = await ApiClient.request<WorkbenchState>("/v1/workbench");
      this.state.workbench = workbench;
      this.state.connection = workbench.connection ?? { mode: "local", reachable: true };
    } catch (error) {
      await this.refreshConnection();
      if (!background) this.setNotice(this.message(error), "error");
    } finally {
      if (!background) {
        this.state.loading = false;
        this.state.analyzing = false;
      }
    }
  }

  async refreshConnection(): Promise<void> {
    try {
      this.state.connection = await ApiClient.request<ConnectionStatus>("/v1/connections/status");
    } catch {
      // Page content remains usable if the optional connection badge cannot be refreshed.
    }
  }

  scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      if (this.state.busy) return this.scheduleRefresh();
      void (this.loadWorkbench ? this.refresh({ background: true }) : this.refreshConnection());
    }, refreshDelayMs);
  }

  async mutate<T>(path: string, options: RequestInit, { refresh = true } = {}): Promise<T> {
    this.state.busy = true;
    try {
      const result = await ApiClient.request<T>(path, options);
      if (refresh) await this.refresh({ analyze: true });
      return result;
    } finally {
      this.state.busy = false;
    }
  }

  setNotice(message: string, kind = ""): void {
    this.state.notice = { message, kind };
  }

  clearNotice(): void {
    this.state.notice = null;
  }

  message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export const workbenchStore = new WorkbenchStore();
