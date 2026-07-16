export class KeyedMutationGate {
  private readonly active = new Map<string, number>();
  private readonly blocked = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();

  begin(key: string): () => void {
    this.active.set(key, this.activeCount(key) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const nextCount = Math.max(0, this.activeCount(key) - 1);
      if (nextCount > 0) {
        this.active.set(key, nextCount);
        return;
      }
      this.active.delete(key);
      const pending = this.waiters.get(key);
      this.waiters.delete(key);
      pending?.forEach(resolve => resolve());
    };
  }

  activeCount(key: string): number {
    return this.active.get(key) ?? 0;
  }

  isBlocked(key: string): boolean {
    return this.blocked.has(key);
  }

  tryBegin(key: string): (() => void) | null {
    if (this.isBlocked(key)) return null;
    return this.begin(key);
  }

  tryBlock(key: string): (() => void) | null {
    if (this.isBlocked(key)) return null;
    this.blocked.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.blocked.delete(key);
    };
  }

  async waitForIdle(key: string, timeoutMs: number): Promise<boolean> {
    if (this.activeCount(key) === 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const pending = this.waiters.get(key) ?? new Set<() => void>();
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(onIdle);
        if (pending.size === 0) this.waiters.delete(key);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      pending.add(onIdle);
      this.waiters.set(key, pending);
      const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    });
  }
}
