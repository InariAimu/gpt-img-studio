/** Serialize whole-settings writes, preserving the latest optimistic edit. */
export class SettingsWrites<T, R> {
  private chain: Promise<unknown> = Promise.resolve();
  private revision = 0;
  optimistic: T | undefined;
  private callbacks: {
    save: (settings: T, keys: Record<string, string>) => Promise<R>;
    changed: (settings: T) => void;
    saved: (result: R, optimistic: T | undefined) => void;
    failed: (error: unknown, optimistic: T | undefined) => void;
    busy: (value: boolean) => void;
  };

  constructor(callbacks: SettingsWrites<T, R>['callbacks']) { this.callbacks = callbacks; }

  enqueue(settings: T, keys: Record<string, string> = {}): Promise<R> {
    const revision = ++this.revision;
    this.optimistic = settings;
    this.callbacks.changed(settings);
    this.callbacks.busy(true);
    const result = this.chain.then(() => this.callbacks.save(settings, keys)).then(value => {
      if (revision === this.revision) this.optimistic = undefined;
      this.callbacks.saved(value, this.optimistic);
      return value;
    }, error => {
      if (revision === this.revision) this.optimistic = undefined;
      this.callbacks.failed(error, this.optimistic);
      throw error;
    }).finally(() => { if (revision === this.revision) this.callbacks.busy(false); });
    this.chain = result.catch(() => {});
    return result;
  }

  async idle() { await this.chain; }
}
