import {
  RelayClient,
  RelayerTxType,
  type RelayerTransactionResponse,
  type Transaction,
} from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { encodeFunctionData, type Hex, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import type { BotConfig, TradeIntent } from "../types/domain.js";

const CTF_EXCHANGE_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

const ctfAbi = [
  {
    type: "function",
    name: "mergePositions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "partition", type: "uint256[]" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
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

export class PolyRelayerClient {
  private readonly relayClient?: RelayClient;
  private readonly builderConfig?: BuilderConfig;
  private readonly enabled: boolean;
  private rateLimitedUntilMs: number | null = null;

  constructor(private readonly config: BotConfig) {
    this.enabled = Boolean(config.polymarketRelayerUrl && config.polygonRpc);
    if (!this.enabled) {
      return;
    }

    const account = privateKeyToAccount(config.privateKey);
    const walletClient = createWalletClient({
      account,
      chain: config.chainId === 137 ? polygon : polygonAmoy,
      transport: http(config.polygonRpc),
    });

    this.builderConfig = this.createBuilderConfig(config);

    this.relayClient = new RelayClient(
      config.polymarketRelayerUrl!,
      config.chainId,
      walletClient,
      this.builderConfig,
      RelayerTxType.PROXY,
    );
  }

  private createBuilderConfig(config: BotConfig): BuilderConfig | undefined {
    const hasLocalCreds =
      Boolean(config.builderApiKey) && Boolean(config.builderApiSecret) && Boolean(config.builderApiPassphrase);

    const hasRemoteSigner = Boolean(config.builderSignerUrl);

    if (!hasLocalCreds && !hasRemoteSigner) {
      return undefined;
    }

    const hasPartialLocalCreds =
      Boolean(config.builderApiKey) || Boolean(config.builderApiSecret) || Boolean(config.builderApiPassphrase);

    if (!hasLocalCreds && hasPartialLocalCreds) {
      throw new Error(
        "Invalid builder configuration: BUILDER_API_KEY, BUILDER_API_SECRET, and BUILDER_API_PASSPHRASE must all be set",
      );
    }

    if (hasLocalCreds) {
      return new BuilderConfig({
        localBuilderCreds: {
          key: config.builderApiKey!,
          secret: config.builderApiSecret!,
          passphrase: config.builderApiPassphrase!,
        },
      });
    }

    return new BuilderConfig({
      remoteBuilderConfig: {
        url: config.builderSignerUrl!,
        token: config.builderSignerToken,
      },
    });
  }

  isAvailable(): boolean {
    return this.enabled && Boolean(this.relayClient);
  }

  getRateLimitedUntilMs(): number | null {
    return this.rateLimitedUntilMs;
  }

  private isRateLimitedNow(): boolean {
    return this.rateLimitedUntilMs !== null && Date.now() < this.rateLimitedUntilMs;
  }

  private parseResetSeconds(message: string): number | null {
    const match = message.match(/resets in\s+(\d+)\s+seconds/i);
    if (!match) {
      return null;
    }

    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return null;
    }

    return seconds;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private updateRateLimitFromError(error: unknown): void {
    const message = this.formatError(error);
    const has429 = /\b429\b/.test(message) || /too many requests/i.test(message) || /quota exceeded/i.test(message);
    if (!has429) {
      return;
    }

    const resetSeconds = this.parseResetSeconds(message);
    const fallbackSeconds = 60;
    const waitSeconds = resetSeconds ?? fallbackSeconds;
    this.rateLimitedUntilMs = Date.now() + waitSeconds * 1000;
  }

  private async executeWithRateLimitGuard(
    txs: Transaction[],
    note: string,
  ): Promise<RelayerTransactionResponse | { skipped: true; reason: string; retryAt: number | null } | null> {
    if (!this.isAvailable()) {
      return null;
    }

    if (this.isRateLimitedNow()) {
      return {
        skipped: true,
        reason: "relayer_rate_limited",
        retryAt: this.rateLimitedUntilMs,
      };
    }

    try {
      return await this.relayClient!.execute(txs, note);
    } catch (error) {
      this.updateRateLimitFromError(error);
      throw error;
    }
  }

  async mergeTokens(
    conditionId: string,
    amount: bigint,
  ): Promise<
    RelayerTransactionResponse | { dryRun: true; intent: TradeIntent } | { skipped: true; reason: string; retryAt: number | null } | null
  > {
    if (!this.isAvailable()) {
      return null;
    }

    const normalizedConditionId = normalizeBytes32(conditionId);
    const data = encodeFunctionData({
      abi: ctfAbi,
      functionName: "mergePositions",
      args: [USDC_ADDRESS, ZERO_BYTES32, normalizedConditionId, [1n, 2n], amount],
    });

    const tx: Transaction = {
      to: CTF_EXCHANGE_ADDRESS,
      data,
      value: "0",
    };

    if (this.config.dryRun) {
      return {
        dryRun: true,
        intent: {
          action: "MERGE",
          payload: {
            conditionId: normalizedConditionId,
            amount: amount.toString(),
            to: CTF_EXCHANGE_ADDRESS,
          },
        },
      };
    }

    return this.executeWithRateLimitGuard([tx], "merge tokens");
  }

  async redeemPositions(
    conditionId: string,
    indexSets: bigint[] = [1n, 2n],
  ): Promise<
    RelayerTransactionResponse | { dryRun: true; intent: TradeIntent } | { skipped: true; reason: string; retryAt: number | null } | null
  > {
    if (!this.isAvailable()) {
      return null;
    }

    const normalizedConditionId = normalizeBytes32(conditionId);
    const data = encodeFunctionData({
      abi: ctfAbi,
      functionName: "redeemPositions",
      args: [USDC_ADDRESS, ZERO_BYTES32, normalizedConditionId, indexSets],
    });

    const tx: Transaction = {
      to: CTF_EXCHANGE_ADDRESS,
      data,
      value: "0",
    };

    if (this.config.dryRun) {
      return {
        dryRun: true,
        intent: {
          action: "REDEEM",
          payload: {
            conditionId: normalizedConditionId,
            indexSets: indexSets.map((value) => value.toString()),
            to: CTF_EXCHANGE_ADDRESS,
          },
        },
      };
    }

    return this.executeWithRateLimitGuard([tx], "redeem positions");
  }
}
