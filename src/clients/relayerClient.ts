import {
  OperationType,
  RelayClient,
  type RelayerTransactionResponse,
  type SafeTransaction
} from "@polymarket/relayer-client";
import {
  BuilderConfig,
  BuilderType,
  type BuilderHeaderPayload
} from "@polymarket/builder-signing-sdk";
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
      { name: "amount", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "redeemPositions",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" }
    ],
    outputs: []
  }
] as const;

const normalizeBytes32 = (value: string): Hex => {
  const hex = value.toLowerCase().startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[a-f0-9]{64}$/i.test(hex)) {
    throw new Error(`Invalid bytes32 value: ${value}`);
  }
  return hex as Hex;
};

export class PolyRelayerClient {
  private static readonly BUILDER_HEADERS_METHOD = "POST";
  private static readonly BUILDER_HEADERS_PATH = "/submit";

  private readonly relayClient?: RelayClient;
  private readonly builderConfig?: BuilderConfig;
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
      transport: http(config.polygonRpc)
    });

    this.relayClient = new RelayClient(config.polymarketRelayerUrl!, config.chainId, walletClient);

    this.builderConfig = this.createBuilderConfig(config);
    if (this.builderConfig) {
      this.wrapRelayerSubmitWithBuilderHeaders(this.relayClient, this.builderConfig);
    }
  }

  private createBuilderConfig(config: BotConfig): BuilderConfig | undefined {
    const hasLocalCreds =
      Boolean(config.builderApiKey) &&
      Boolean(config.builderApiSecret) &&
      Boolean(config.builderApiPassphrase);

    const hasRemoteSigner = Boolean(config.builderSignerUrl);

    if (!hasLocalCreds && !hasRemoteSigner) {
      return undefined;
    }

    const hasPartialLocalCreds =
      Boolean(config.builderApiKey) ||
      Boolean(config.builderApiSecret) ||
      Boolean(config.builderApiPassphrase);

    if (!hasLocalCreds && hasPartialLocalCreds) {
      throw new Error(
        "Invalid builder configuration: BUILDER_API_KEY, BUILDER_API_SECRET, and BUILDER_API_PASSPHRASE must all be set"
      );
    }

    if (hasLocalCreds) {
      return new BuilderConfig({
        localBuilderCreds: {
          key: config.builderApiKey!,
          secret: config.builderApiSecret!,
          passphrase: config.builderApiPassphrase!
        }
      });
    }

    return new BuilderConfig({
      remoteBuilderConfig: {
        url: config.builderSignerUrl!,
        token: config.builderSignerToken
      }
    });
  }

  private wrapRelayerSubmitWithBuilderHeaders(relayClient: RelayClient, builderConfig: BuilderConfig): void {
    if (!builderConfig.isValid() || builderConfig.getBuilderType() === BuilderType.UNAVAILABLE) {
      return;
    }

    if (!this.config.dryRun) {
      const builderType = builderConfig.getBuilderType();
      console.info("Builder signing enabled for relayer submit", { builderType });
    }

    const relayAny = relayClient as unknown as {
      send: (
        endpoint: string,
        method: string,
        headers?: Record<string, string>,
        data?: unknown,
        params?: unknown
      ) => Promise<unknown>;
      relayerUrl: string;
    };

    const originalSend = relayAny.send.bind(relayAny);
    const relayerUrl = relayAny.relayerUrl;

    relayAny.send = async (
      endpoint: string,
      method: string,
      headers?: Record<string, string>,
      data?: unknown,
      params?: unknown
    ): Promise<unknown> => {
      let mergedHeaders = headers;

      const shouldSignSubmit =
        method.toUpperCase() === PolyRelayerClient.BUILDER_HEADERS_METHOD &&
        endpoint.startsWith(relayerUrl) &&
        endpoint.endsWith(PolyRelayerClient.BUILDER_HEADERS_PATH);

      if (shouldSignSubmit) {
        const body = data === undefined ? "" : JSON.stringify(data);
        const payload = await builderConfig.generateBuilderHeaders(
          PolyRelayerClient.BUILDER_HEADERS_METHOD,
          PolyRelayerClient.BUILDER_HEADERS_PATH,
          body
        );

        if (payload) {
          mergedHeaders = {
            ...(headers ?? {}),
            ...this.toHttpBuilderHeaders(payload)
          };
        }
      }

      return originalSend(endpoint, method, mergedHeaders, data, params);
    };
  }

  private toHttpBuilderHeaders(payload: BuilderHeaderPayload): Record<string, string> {
    return {
      "POLY-BUILDER-API-KEY": payload.POLY_BUILDER_API_KEY,
      "POLY-BUILDER-TIMESTAMP": payload.POLY_BUILDER_TIMESTAMP,
      "POLY-BUILDER-PASSPHRASE": payload.POLY_BUILDER_PASSPHRASE,
      "POLY-BUILDER-SIGNATURE": payload.POLY_BUILDER_SIGNATURE
    };
  }

  isAvailable(): boolean {
    return this.enabled && Boolean(this.relayClient);
  }

  async mergeTokens(conditionId: string, amount: bigint): Promise<RelayerTransactionResponse | { dryRun: true; intent: TradeIntent } | null> {
    if (!this.isAvailable()) {
      return null;
    }

    const normalizedConditionId = normalizeBytes32(conditionId);
    const data = encodeFunctionData({
      abi: ctfAbi,
      functionName: "mergePositions",
      args: [USDC_ADDRESS, ZERO_BYTES32, normalizedConditionId, [1n, 2n], amount]
    });

    const tx: SafeTransaction = {
      to: CTF_EXCHANGE_ADDRESS,
      operation: OperationType.Call,
      data,
      value: "0"
    };

    if (this.config.dryRun) {
      return {
        dryRun: true,
        intent: {
          action: "MERGE",
          payload: {
            conditionId: normalizedConditionId,
            amount: amount.toString(),
            to: CTF_EXCHANGE_ADDRESS
          }
        }
      };
    }

    return this.relayClient!.executeSafeTransactions([tx], "merge tokens");
  }

  async redeemPositions(conditionId: string, indexSets: bigint[] = [1n, 2n]): Promise<RelayerTransactionResponse | { dryRun: true; intent: TradeIntent } | null> {
    if (!this.isAvailable()) {
      return null;
    }

    const normalizedConditionId = normalizeBytes32(conditionId);
    const data = encodeFunctionData({
      abi: ctfAbi,
      functionName: "redeemPositions",
      args: [USDC_ADDRESS, ZERO_BYTES32, normalizedConditionId, indexSets]
    });

    const tx: SafeTransaction = {
      to: CTF_EXCHANGE_ADDRESS,
      operation: OperationType.Call,
      data,
      value: "0"
    };

    if (this.config.dryRun) {
      return {
        dryRun: true,
        intent: {
          action: "REDEEM",
          payload: {
            conditionId: normalizedConditionId,
            indexSets: indexSets.map((value) => value.toString()),
            to: CTF_EXCHANGE_ADDRESS
          }
        }
      };
    }

    return this.relayClient!.executeSafeTransactions([tx], "redeem positions");
  }
}
