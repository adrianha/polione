import type { PolyRelayerClient } from "../clients/relayerClient.js";
import type { RelayerOperationResult } from "../clients/relayerClient.js";

export class SettlementService {
  constructor(private readonly relayerClient: PolyRelayerClient) {}

  async mergeEqualPositions(conditionId: string, amount: number): Promise<RelayerOperationResult> {
    const scaledAmount = BigInt(Math.floor(amount * 1_000_000));
    return this.relayerClient.mergeTokens(conditionId, scaledAmount);
  }

  async redeemResolvedPositions(conditionId: string): Promise<RelayerOperationResult> {
    return this.relayerClient.redeemPositions(conditionId, [1n, 2n]);
  }
}
