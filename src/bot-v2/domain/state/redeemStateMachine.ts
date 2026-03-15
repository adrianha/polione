import type { BotConfig, RedeemStateRecord, RedeemTerminalReason } from "../../../types/domain.js";
import { StateStore } from "../../../utils/stateStore.js";

export class RedeemStateMachine {
  private readonly redeemStates = new Map<string, RedeemStateRecord>();

  constructor(
    private readonly config: BotConfig,
    private readonly stateStore: StateStore,
  ) {}

  async load(): Promise<void> {
    const loaded = await this.stateStore.loadRedeemStates();
    for (const [conditionId, state] of loaded.entries()) {
      this.redeemStates.set(conditionId, state);
    }
  }

  async persist(): Promise<void> {
    await this.stateStore.saveRedeemStates(this.redeemStates);
  }

  size(): number {
    return this.redeemStates.size;
  }

  private defaultState(nowMs: number): RedeemStateRecord {
    return {
      status: "pending",
      attempts: 0,
      nextRetryAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  }

  private getState(conditionId: string): RedeemStateRecord {
    const existing = this.redeemStates.get(conditionId);
    if (existing) {
      return existing;
    }

    const state = this.defaultState(Date.now());
    this.redeemStates.set(conditionId, state);
    return state;
  }

  private transition(params: {
    conditionId: string;
    status?: RedeemStateRecord["status"];
    attempts?: number;
    nextRetryAtMs?: number;
    lastError?: string;
    terminalReason?: RedeemTerminalReason;
  }): RedeemStateRecord {
    const previous = this.getState(params.conditionId);
    const next: RedeemStateRecord = {
      status: params.status ?? previous.status,
      attempts: params.attempts ?? previous.attempts,
      nextRetryAtMs: params.nextRetryAtMs ?? previous.nextRetryAtMs,
      updatedAtMs: Date.now(),
      lastError: params.lastError ?? previous.lastError,
      terminalReason: params.terminalReason ?? previous.terminalReason,
    };
    this.redeemStates.set(params.conditionId, next);
    return next;
  }

  pruneTerminalStates(nowMs: number): number {
    let removed = 0;
    for (const [conditionId, state] of this.redeemStates.entries()) {
      if (state.status !== "terminal") {
        continue;
      }

      const ageMs = nowMs - state.updatedAtMs;
      if (ageMs >= this.config.redeemTerminalStateTtlMs) {
        this.redeemStates.delete(conditionId);
        removed += 1;
      }
    }
    return removed;
  }

  shouldAttempt(conditionId: string, nowMs: number): boolean {
    const state = this.getState(conditionId);
    if (state.status === "terminal") {
      return false;
    }
    if (state.attempts >= this.config.redeemMaxRetries) {
      this.markTerminal(
        conditionId,
        "max_retries_exhausted",
        state.lastError ?? "Retry budget exhausted",
      );
      return false;
    }
    return nowMs >= state.nextRetryAtMs;
  }

  markSubmitted(conditionId: string): RedeemStateRecord {
    const current = this.getState(conditionId);
    return this.transition({
      conditionId,
      status: "submitted",
      attempts: current.attempts + 1,
      nextRetryAtMs: Date.now(),
      lastError: undefined,
      terminalReason: undefined,
    });
  }

  scheduleRetry(params: {
    conditionId: string;
    reason: string;
    retryAtMs?: number;
    incrementAttempt?: boolean;
  }): RedeemStateRecord {
    const current = this.getState(params.conditionId);
    const attempts = params.incrementAttempt ? current.attempts + 1 : current.attempts;
    if (attempts >= this.config.redeemMaxRetries) {
      return this.transition({
        conditionId: params.conditionId,
        status: "terminal",
        attempts,
        nextRetryAtMs: Date.now(),
        lastError: params.reason,
        terminalReason: "max_retries_exhausted",
      });
    }

    const retryAtMs =
      params.retryAtMs ?? Date.now() + Math.max(this.config.redeemRetryBackoffMs, 1000);
    return this.transition({
      conditionId: params.conditionId,
      status: "pending",
      attempts,
      nextRetryAtMs: retryAtMs,
      lastError: params.reason,
    });
  }

  markTerminal(
    conditionId: string,
    terminalReason: RedeemTerminalReason,
    lastError?: string,
  ): RedeemStateRecord {
    return this.transition({
      conditionId,
      status: "terminal",
      nextRetryAtMs:
        Date.now() + (terminalReason === "success" ? this.config.redeemSuccessCooldownMs : 0),
      terminalReason,
      lastError,
    });
  }
}
