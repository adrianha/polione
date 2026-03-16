import { sleepMs } from "../utils/time.js";

type BotLike = any;

type ScheduledTask = {
  id: "market" | "redeem" | "telegram";
  intervalMs: number;
  nextRunAtMs: number;
  run: () => Promise<void>;
};

export const runScheduler = async (bot: BotLike, positionsAddress: string): Promise<void> => {
  let nextMarketDelayMs = 0;
  const nowMs = Date.now();
  const tasks: ScheduledTask[] = [
    {
      id: "market",
      intervalMs: bot.config.marketPollMs,
      nextRunAtMs: nowMs,
      run: async () => {
        try {
          const signal = await bot.runMarketTask(positionsAddress);
          nextMarketDelayMs = bot.computeNextMarketInterval(signal);
        } catch (error) {
          nextMarketDelayMs = bot.config.marketPollMs;
          bot.logger.error({ error }, "Market task error");
          await bot.notifyOperationalIssue({
            title: "Market task error",
            severity: "error",
            dedupeKey: "task-error:market",
            error,
          });
        }
      },
    },
  ];

  if (bot.config.redeemEnabled && bot.relayerClient.isAvailable()) {
    tasks.push({
      id: "redeem",
      intervalMs: bot.config.redeemPollMs,
      nextRunAtMs: nowMs,
      run: async () => bot.runRedeemTask(positionsAddress),
    });
  }

  if (bot.telegramClient.isEnabled()) {
    tasks.push({
      id: "telegram",
      intervalMs: bot.config.telegramPollMs,
      nextRunAtMs: nowMs,
      run: async () => bot.runTelegramTask(),
    });
  }

  while (!bot.stopped) {
    const loopNowMs = Date.now();
    const dueTasks = tasks.filter((task) => task.nextRunAtMs <= loopNowMs);

    if (dueTasks.length === 0) {
      const nextWakeAtMs = Math.min(...tasks.map((task) => task.nextRunAtMs));
      await sleepMs(Math.max(1, nextWakeAtMs - loopNowMs));
      continue;
    }

    for (const task of dueTasks) {
      await task.run();
      task.nextRunAtMs =
        task.id === "market"
          ? Date.now() + Math.max(1, nextMarketDelayMs || bot.config.marketPollMs)
          : Date.now() + task.intervalMs;
    }
  }
};
