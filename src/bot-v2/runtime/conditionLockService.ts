export class ConditionLockService {
  private readonly inFlightConditions = new Set<string>();

  async withConditionLock<T>(
    conditionId: string,
    run: () => Promise<T>,
  ): Promise<{ executed: boolean; result?: T }> {
    if (this.inFlightConditions.has(conditionId)) {
      return { executed: false };
    }

    this.inFlightConditions.add(conditionId);
    try {
      const result = await run();
      return { executed: true, result };
    } finally {
      this.inFlightConditions.delete(conditionId);
    }
  }
}
