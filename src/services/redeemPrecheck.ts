import { createPublicClient, http, type Hex } from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import type { BotConfig } from "../types/domain.js";

const CTF_EXCHANGE_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

const ctfAbi = [
  {
    type: "function",
    name: "redeemPositions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

const normalizeBytes32 = (value: string): Hex => {
  const hex = value.toLowerCase().startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[a-f0-9]{64}$/i.test(hex)) {
    throw new Error(`Invalid bytes32 value: ${value}`);
  }
  return hex as Hex;
};

export type RedeemPrecheckStatus =
  | "eligible"
  | "not_resolved"
  | "no_redeemable_balance"
  | "retryable_error"
  | "permanent_error";

export interface RedeemPrecheckResult {
  status: RedeemPrecheckStatus;
  reason?: string;
}

export class RedeemPrecheckService {
  private readonly enabled: boolean;
  private readonly client: ReturnType<typeof createPublicClient> | null;

  constructor(config: BotConfig) {
    this.enabled = Boolean(config.polygonRpc);
    this.client = this.enabled
      ? createPublicClient({
          chain: config.chainId === 137 ? polygon : polygonAmoy,
          transport: http(config.polygonRpc),
        })
      : null;
  }

  isAvailable(): boolean {
    return this.enabled && this.client !== null;
  }

  async check(params: {
    conditionId: string;
    positionsAddress: `0x${string}`;
    indexSets?: bigint[];
  }): Promise<RedeemPrecheckResult> {
    if (!this.client) {
      return {
        status: "eligible",
      };
    }

    try {
      const normalizedConditionId = normalizeBytes32(params.conditionId);
      await this.client.simulateContract({
        abi: ctfAbi,
        address: CTF_EXCHANGE_ADDRESS,
        functionName: "redeemPositions",
        args: [USDC_ADDRESS, ZERO_BYTES32, normalizedConditionId, params.indexSets ?? [1n, 2n]],
        account: params.positionsAddress,
      });
      return { status: "eligible" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const normalized = message.toLowerCase();

      if (normalized.includes("invalid bytes32 value")) {
        return { status: "permanent_error", reason: message };
      }
      if (
        normalized.includes("condition not prepared") ||
        normalized.includes("payout denominator") ||
        normalized.includes("not resolved")
      ) {
        return { status: "not_resolved", reason: message };
      }
      if (
        normalized.includes("result for this account is zero") ||
        normalized.includes("resulting payout is not enough")
      ) {
        return { status: "no_redeemable_balance", reason: message };
      }

      return { status: "retryable_error", reason: message };
    }
  }
}
