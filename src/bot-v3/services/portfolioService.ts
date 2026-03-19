import type { Logger } from "pino";
import { DataClient } from "../../clients/dataClient.js";
import { V3PositionStore } from "../state/positionStore.js";
import type { V3Config, V3LivePosition } from "../types.js";

export class V3PortfolioService {
  private warnedExternalExposure = false;

  constructor(
    private readonly config: V3Config,
    private readonly dataClient: DataClient,
    private readonly positionStore: V3PositionStore,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<V3LivePosition | null> {
    return this.positionStore.load();
  }

  getLivePosition(): V3LivePosition | null {
    return this.positionStore.getLivePosition();
  }

  async saveLivePosition(position: V3LivePosition): Promise<void> {
    await this.positionStore.save(position);
  }

  async clearLivePosition(): Promise<void> {
    await this.positionStore.clear();
  }

  async hasCapacityForNewPosition(positionsAddress: string): Promise<boolean> {
    if (this.positionStore.getLivePosition()) {
      return false;
    }

    const hasExternalExposure = await this.hasAnyExternalExposure(positionsAddress);
    return !hasExternalExposure;
  }

  async getConditionTokenSize(
    positionsAddress: string,
    conditionId: string,
    tokenId: string,
  ): Promise<number> {
    const positions = await this.dataClient.getPositions(positionsAddress, conditionId);
    const size = positions.reduce((sum, position) => {
      if (position.asset !== tokenId) {
        return sum;
      }
      const parsed = Number(position.size);
      return sum + (Number.isFinite(parsed) ? parsed : 0);
    }, 0);
    return Number(size.toFixed(6));
  }

  async hasAnyConditionExposure(positionsAddress: string, conditionId: string): Promise<boolean> {
    const positions = await this.dataClient.getPositions(positionsAddress, conditionId);
    return positions.some((position) => Number(position.size) > this.minLiveSize());
  }

  async getTokenBalanceState(
    positionsAddress: string,
    conditionId: string,
    tokenId: string,
  ): Promise<{ heldSize: number; redeemable: boolean }> {
    const positions = await this.dataClient.getPositions(positionsAddress, conditionId);
    const relevant = positions.filter((position) => position.asset === tokenId);
    const heldSize = relevant.reduce((sum, position) => {
      const parsed = Number(position.size);
      return sum + (Number.isFinite(parsed) ? parsed : 0);
    }, 0);

    return {
      heldSize: Number(heldSize.toFixed(6)),
      redeemable: relevant.some((position) => position.redeemable === true),
    };
  }

  private async hasAnyExternalExposure(positionsAddress: string): Promise<boolean> {
    const positions = await this.dataClient.getPositions(positionsAddress);
    const hasExposure = positions.some((position) => Number(position.size) > this.minLiveSize());

    if (hasExposure && !this.warnedExternalExposure) {
      this.warnedExternalExposure = true;
      this.logger.warn(
        "V3 entry blocked because wallet already has live exposure; clear positions or persist them into V3 state first",
      );
    }
    if (!hasExposure) {
      this.warnedExternalExposure = false;
    }

    return hasExposure;
  }

  private minLiveSize(): number {
    return 0.0001;
  }
}
