// Workspace file watcher per spec §3 and §9.3. The watcher only triggers a
// debounced local refresh — it never auto-pulls or auto-pushes per the spec's
// "no automatic syncing" invariant.

import { watch, type FSWatcher } from "chokidar";

export type FileWatcherStatus = {
  active: boolean;
  error?: string;
  lastEventAt?: string;
  paths: string[];
};

export type FileWatcherOptions = {
  workspaceDir: string;
  /** Files under this directory are still watched but distinguishable as templates. */
  templateDir?: string;
  /** Called once per debounce window after any change/add/unlink event. */
  onChange: () => void | Promise<void>;
  /** Debounce window in ms. Defaults to 250. */
  debounceMs?: number;
  /** Use polling for file systems that do not emit native events reliably. Defaults to true. */
  usePolling?: boolean;
  /** Polling interval in ms when polling is enabled. Defaults to 100. */
  pollingIntervalMs?: number;
};

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private readyPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _status: FileWatcherStatus;

  constructor(private readonly options: FileWatcherOptions) {
    this._status = { active: false, paths: this.computePaths() };
  }

  get status(): FileWatcherStatus {
    return { ...this._status };
  }

  start(): Promise<void> {
    if (this.watcher) return this.readyPromise ?? Promise.resolve();
    try {
      const paths = this.computePaths();
      this.watcher = watch(paths, {
        ignoreInitial: true,
        ignored: (path: string) => path.includes(`${"/"}.surfboard${"/"}`) || path.endsWith(".surfboard"),
        persistent: true,
        usePolling: this.options.usePolling ?? true,
        interval: this.options.pollingIntervalMs ?? 100,
      });
      const trigger = (): void => {
        this._status.lastEventAt = new Date().toISOString();
        if (this.timer) clearTimeout(this.timer);
        const delay = this.options.debounceMs ?? 250;
        this.timer = setTimeout(() => {
          this.timer = null;
          void Promise.resolve(this.options.onChange()).catch((err) => {
            this._status.error = err instanceof Error ? err.message : String(err);
          });
        }, delay);
      };
      this.watcher.on("add", trigger).on("change", trigger).on("unlink", trigger);
      this.readyPromise = new Promise((resolve) => {
        this.watcher?.once("ready", resolve);
      });
      this.watcher.on("error", (err: unknown) => {
        this._status.error = err instanceof Error ? err.message : String(err);
        this._status.active = false;
      });
      this._status.active = true;
      this._status.error = undefined;
      return this.readyPromise;
    } catch (err) {
      this._status.active = false;
      this._status.error = err instanceof Error ? err.message : String(err);
      this.readyPromise = Promise.resolve();
      return this.readyPromise;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.readyPromise = null;
    this._status.active = false;
  }

  private computePaths(): string[] {
    const out: string[] = [this.options.workspaceDir];
    if (this.options.templateDir && this.options.templateDir !== this.options.workspaceDir) {
      out.push(this.options.templateDir);
    }
    return out;
  }
}
