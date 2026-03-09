type SimulationConfig = {
  runs: number;
  horizonSeconds: number;
  forceWindowSeconds: number;
  repriceIntervalMs: number;
  minPriceDelta: number;
  makerOffset: number;
  orderPrice: number;
  feeBuffer: number;
  minProfitPerShare: number;
  initialMid: number;
  spread: number;
  volatilityPerStep: number;
  makerFillBase: number;
  makerFillAggression: number;
  forceTakerFillProb: number;
};

type Outcome = "maker-balanced" | "force-hedged" | "residual-imbalanced";

type RunResult = {
  outcome: Outcome;
  fillPrice?: number;
  steps: number;
};

const DEFAULTS: SimulationConfig = {
  runs: 5000,
  horizonSeconds: 90,
  forceWindowSeconds: 20,
  repriceIntervalMs: 1500,
  minPriceDelta: 0.002,
  makerOffset: 0.001,
  orderPrice: 0.35,
  feeBuffer: 0.01,
  minProfitPerShare: 0.005,
  initialMid: 0.35,
  spread: 0.008,
  volatilityPerStep: 0.002,
  makerFillBase: 0.02,
  makerFillAggression: 0.35,
  forceTakerFillProb: 0.95,
};

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const round = (v: number, n = 4): number => Number(v.toFixed(n));

const parseArgs = (): SimulationConfig => {
  const cfg = { ...DEFAULTS };
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const [rawKey, rawValue] = arg.slice(2).split("=");
    const key = rawKey as keyof SimulationConfig;
    if (!(key in cfg) || rawValue === undefined) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    cfg[key] = value;
  }
  return cfg;
};

const nextBook = (mid: number, spread: number, volatilityPerStep: number): { mid: number; bid: number; ask: number } => {
  const shock = (Math.random() * 2 - 1) * volatilityPerStep;
  const nextMid = clamp(mid + shock, 0.01, 0.99);
  const halfSpread = spread / 2;
  const bid = clamp(nextMid - halfSpread, 0.001, 0.998);
  const ask = clamp(nextMid + halfSpread, bid + 0.001, 0.999);
  return { mid: nextMid, bid, ask };
};

const makerPrice = (
  bid: number,
  ask: number,
  maxMissingPrice: number,
  makerOffset: number,
): number => {
  const makerCandidate = bid + makerOffset;
  const nonCrossingCap = Math.max(0, ask - makerOffset);
  return round(Math.min(maxMissingPrice, makerCandidate, nonCrossingCap), 4);
};

const makerFillProbability = (
  orderPx: number,
  ask: number,
  spread: number,
  makerFillBase: number,
  makerFillAggression: number,
): number => {
  const edgeToAsk = Math.max(0, ask - orderPx);
  const normalizedAggression = clamp(1 - edgeToAsk / Math.max(0.001, spread), 0, 1);
  return clamp(makerFillBase + makerFillAggression * normalizedAggression, 0, 0.99);
};

const runOne = (cfg: SimulationConfig): RunResult => {
  let mid = cfg.initialMid;
  let secondsRemaining = cfg.horizonSeconds;
  let activeMissingOrder: number | null = null;
  let steps = 0;
  const dtSec = cfg.repriceIntervalMs / 1000;
  const maxMissingPrice = 1 - cfg.orderPrice - cfg.feeBuffer - cfg.minProfitPerShare;

  if (maxMissingPrice <= 0) {
    return { outcome: "residual-imbalanced", steps };
  }

  while (secondsRemaining > cfg.forceWindowSeconds) {
    steps += 1;
    secondsRemaining -= dtSec;
    const book = nextBook(mid, cfg.spread, cfg.volatilityPerStep);
    mid = book.mid;

    const nextPx = makerPrice(book.bid, book.ask, maxMissingPrice, cfg.makerOffset);
    if (nextPx <= 0) {
      continue;
    }

    if (activeMissingOrder === null || Math.abs(activeMissingOrder - nextPx) >= cfg.minPriceDelta) {
      activeMissingOrder = nextPx;
    }

    if (activeMissingOrder === null) {
      continue;
    }

    const pFill = makerFillProbability(
      activeMissingOrder,
      book.ask,
      cfg.spread,
      cfg.makerFillBase,
      cfg.makerFillAggression,
    );
    if (Math.random() < pFill) {
      return {
        outcome: "maker-balanced",
        fillPrice: activeMissingOrder,
        steps,
      };
    }
  }

  const forceBook = nextBook(mid, cfg.spread, cfg.volatilityPerStep);
  const hedgePrice = forceBook.ask;
  if (hedgePrice <= maxMissingPrice && Math.random() < cfg.forceTakerFillProb) {
    return {
      outcome: "force-hedged",
      fillPrice: round(hedgePrice, 4),
      steps,
    };
  }

  return { outcome: "residual-imbalanced", steps };
};

const summarize = (cfg: SimulationConfig): void => {
  let makerBalanced = 0;
  let forceHedged = 0;
  let residual = 0;
  const lockPnlPerShare: number[] = [];

  for (let i = 0; i < cfg.runs; i += 1) {
    const result = runOne(cfg);
    if (result.outcome === "maker-balanced") {
      makerBalanced += 1;
      if (result.fillPrice !== undefined) {
        lockPnlPerShare.push(round(1 - cfg.orderPrice - result.fillPrice - cfg.feeBuffer, 6));
      }
    } else if (result.outcome === "force-hedged") {
      forceHedged += 1;
      if (result.fillPrice !== undefined) {
        lockPnlPerShare.push(round(1 - cfg.orderPrice - result.fillPrice - cfg.feeBuffer, 6));
      }
    } else {
      residual += 1;
    }
  }

  const success = makerBalanced + forceHedged;
  const avgLockPnl = lockPnlPerShare.length
    ? round(lockPnlPerShare.reduce((a, b) => a + b, 0) / lockPnlPerShare.length, 6)
    : 0;

  console.log("=== Continuous Repricing Monte Carlo ===");
  console.log(`runs=${cfg.runs} orderPrice=${cfg.orderPrice} forceWindow=${cfg.forceWindowSeconds}s`);
  console.log(
    `maxMissingPrice=${round(1 - cfg.orderPrice - cfg.feeBuffer - cfg.minProfitPerShare, 4)} ` +
      `(feeBuffer=${cfg.feeBuffer}, minProfit=${cfg.minProfitPerShare})`,
  );
  console.log(`maker-balanced: ${round((makerBalanced / cfg.runs) * 100, 2)}%`);
  console.log(`force-hedged: ${round((forceHedged / cfg.runs) * 100, 2)}%`);
  console.log(`residual-imbalanced: ${round((residual / cfg.runs) * 100, 2)}%`);
  console.log(`total-success: ${round((success / cfg.runs) * 100, 2)}%`);
  console.log(`avg-lock-pnl-per-share(success only): ${avgLockPnl}`);
  console.log();
};

const sweepForceWindows = (cfg: SimulationConfig): void => {
  const windows = [10, 15, 20, 25, 30];
  console.log("forceWindow(s)\tmaker(%)\tforce(%)\tresidual(%)");
  for (const windowSec of windows) {
    let makerBalanced = 0;
    let forceHedged = 0;
    let residual = 0;
    const scenario = { ...cfg, forceWindowSeconds: windowSec };
    for (let i = 0; i < cfg.runs; i += 1) {
      const result = runOne(scenario);
      if (result.outcome === "maker-balanced") makerBalanced += 1;
      else if (result.outcome === "force-hedged") forceHedged += 1;
      else residual += 1;
    }
    console.log(
      `${windowSec}\t\t${round((makerBalanced / cfg.runs) * 100, 2)}\t\t${round((forceHedged / cfg.runs) * 100, 2)}\t\t${round((residual / cfg.runs) * 100, 2)}`,
    );
  }
};

const main = (): void => {
  const cfg = parseArgs();
  summarize(cfg);
  sweepForceWindows(cfg);
  console.log();
  console.log("Tip: run with custom params, e.g.");
  console.log(
    "bun run simulate:repricing --orderPrice=0.35 --forceWindowSeconds=20 --runs=20000 --spread=0.01 --volatilityPerStep=0.003",
  );
};

main();
