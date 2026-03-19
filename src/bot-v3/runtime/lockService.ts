export class V3LockService {
  private readonly activeKeys = new Set<string>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<{ executed: boolean; value?: T }> {
    if (this.activeKeys.has(key)) {
      return { executed: false };
    }

    this.activeKeys.add(key);
    try {
      return {
        executed: true,
        value: await fn(),
      };
    } finally {
      this.activeKeys.delete(key);
    }
  }
}
