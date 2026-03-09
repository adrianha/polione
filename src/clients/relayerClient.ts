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
import type {
  BotConfig,
  RelayerDryRunResult,
  RelayerExecutionMeta,
  RelayerSkippedResult,
  TradeIntent,
} from "../types/domain.js";

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

interface BuilderEntry {
  label: string;
  relayClient: RelayClient;
  rateLimitedUntilMs: number | null;
}

type RelayerSuccessResponse = RelayerTransactionResponse & { meta: RelayerExecutionMeta };

type RelayerExecutableResult = RelayerSuccessResponse | RelayerSkippedResult | null;

export type RelayerOperationResult = RelayerExecutableResult | RelayerDryRunResult;

const normalizeBytes32 = (value: string): Hex => {
  const hex = value.toLowerCase().startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[a-f0-9]{64}$/i.test(hex)) {
    throw new Error(`Invalid bytes32 value: ${value}`);
  }
  return hex as Hex;
};

export class PolyRelayerClient {
  private readonly builderEntries: BuilderEntry[] = [];
  private readonly enabled: boolean;

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

    const builderConfigs = this.createBuilderConfigs(config);
    if (builderConfigs.length === 0) {
      this.builderEntries.push({
        label: "builder1",
        relayClient: new RelayClient(
          config.polymarketRelayerUrl!,
          config.chainId,
          walletClient,
          undefined,
          RelayerTxType.PROXY,
        ),
        rateLimitedUntilMs: null,
      });
      return;
    }

    this.builderEntries.push(
      ...builderConfigs.map((builderConfig) => ({
        label: builderConfig.label,
        relayClient: new RelayClient(
          config.polymarketRelayerUrl!,
          config.chainId,
          walletClient,
          builderConfig.config,
          RelayerTxType.PROXY,
        ),
        rateLimitedUntilMs: null,
      })),
    );
  }

  private createBuilderConfigs(config: BotConfig): Array<{ label: string; config: BuilderConfig }> {
    const hasRemoteSigner = Boolean(config.builderSignerUrl);
    const localConfigs = this.createLocalBuilderConfigs(config);

    if (localConfigs.length > 0) {
      return localConfigs;
    }

    if (!hasRemoteSigner) {
      return [];
    }

    return [
      {
        label: "builder1",
        config: new BuilderConfig({
          remoteBuilderConfig: {
            url: config.builderSignerUrl!,
            token: config.builderSignerToken,
          },
        }),
      },
    ];
  }

  private createLocalBuilderConfigs(config: BotConfig): Array<{ label: string; config: BuilderConfig }> {
    const localCreds = [
      {
        label: "builder1",
        key: config.builderApiKey,
        secret: config.builderApiSecret,
        passphrase: config.builderApiPassphrase,
      },
      {
        label: "builder2",
        key: config.builderApiKey2,
        secret: config.builderApiSecret2,
        passphrase: config.builderApiPassphrase2,
      },
    ];

    return localCreds
      .filter((entry) => Boolean(entry.key) && Boolean(entry.secret) && Boolean(entry.passphrase))
      .map((entry) => ({
        label: entry.label,
        config: new BuilderConfig({
          localBuilderCreds: {
            key: entry.key!,
            secret: entry.secret!,
            passphrase: entry.passphrase!,
          },
        }),
      }));
  }

  isAvailable(): boolean {
    return this.enabled && this.builderEntries.length > 0;
  }

  getAvailableBuilderLabels(): string[] {
    if (!this.isAvailable()) {
      return [];
    }

    return this.builderEntries.filter((entry) => !this.isRateLimitedNow(entry)).map((entry) => entry.label);
  }

  private isRateLimitedNow(entry: BuilderEntry): boolean {
    return entry.rateLimitedUntilMs !== null && Date.now() < entry.rateLimitedUntilMs;
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

  private isConfirmedRateLimitError(error: unknown): boolean {
    const message = this.formatError(error);
    return /\b429\b/.test(message) || /too many requests/i.test(message) || /quota exceeded/i.test(message);
  }

  private updateRateLimitFromError(entry: BuilderEntry, error: unknown): void {
    if (!this.isConfirmedRateLimitError(error)) {
      return;
    }

    const message = this.formatError(error);
    const resetSeconds = this.parseResetSeconds(message);
    const fallbackSeconds = 60;
    const waitSeconds = resetSeconds ?? fallbackSeconds;
    entry.rateLimitedUntilMs = Date.now() + waitSeconds * 1000;
  }

  private getRetryAt(): number | null {
    const futureRetryAts = this.builderEntries
      .map((entry) => entry.rateLimitedUntilMs)
      .filter((value): value is number => value !== null && value > Date.now());

    if (futureRetryAts.length === 0) {
      return null;
    }

    return Math.min(...futureRetryAts);
  }

  private withMeta<T extends RelayerTransactionResponse>(result: T, meta: RelayerExecutionMeta): T & { meta: RelayerExecutionMeta } {
    return Object.assign(result, { meta });
  }

  private async executeWithFailover(txs: Transaction[], note: string): Promise<RelayerExecutableResult> {
    if (!this.isAvailable()) {
      return null;
    }

    let lastRateLimitedBuilder: string | null = null;

    for (const entry of this.builderEntries) {
      if (this.isRateLimitedNow(entry)) {
        continue;
      }

      try {
        const result = await entry.relayClient.execute(txs, note);
        entry.rateLimitedUntilMs = null;
        return this.withMeta(result, {
          builderLabel: entry.label,
          failoverFrom: lastRateLimitedBuilder ?? undefined,
        });
      } catch (error) {
        if (!this.isConfirmedRateLimitError(error)) {
          throw error;
        }

        this.updateRateLimitFromError(entry, error);
        lastRateLimitedBuilder ??= entry.label;
      }
    }

    return {
      skipped: true,
      reason: "relayer_rate_limited",
      retryAt: this.getRetryAt(),
    };
  }

  async mergeTokens(conditionId: string, amount: bigint): Promise<RelayerOperationResult> {
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
      const availableEntry = this.builderEntries.find((entry) => !this.isRateLimitedNow(entry));
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
        meta: availableEntry
          ? {
              builderLabel: availableEntry.label,
            }
          : undefined,
      };
    }

    return this.executeWithFailover([tx], "merge tokens");
  }

  async redeemPositions(conditionId: string, indexSets: bigint[] = [1n, 2n]): Promise<RelayerOperationResult> {
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
      const availableEntry = this.builderEntries.find((entry) => !this.isRateLimitedNow(entry));
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
        meta: availableEntry
          ? {
              builderLabel: availableEntry.label,
            }
          : undefined,
      };
    }

    return this.executeWithFailover([tx], "redeem positions");
  }
}
