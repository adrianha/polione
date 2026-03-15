import type { Logger } from "pino";
import { sleep } from "../../utils/time.js";

export interface ScheduledTask {
  name: string;
  intervalSeconds: number;
  startAfterSeconds?: number;
  run: () => Promise<void>;
}

interface SchedulerHooks {
  onTaskError?: (taskName: string, error: unknown) => Promise<void> | void;
}

interface RegisteredTask {
  task: ScheduledTask;
  nextRunAtMs: number;
}

export class Scheduler {
  private readonly tasks: RegisteredTask[] = [];
  private stopped = false;
  private hooks?: SchedulerHooks;

  constructor(
    private readonly logger: Logger,
    private readonly tickSeconds: number,
  ) {}

  setHooks(hooks: SchedulerHooks): void {
    this.hooks = hooks;
  }

  register(task: ScheduledTask): void {
    const intervalSeconds = Math.max(1, task.intervalSeconds);
    this.tasks.push({
      task: { ...task, intervalSeconds },
      nextRunAtMs: Date.now() + Math.max(0, (task.startAfterSeconds ?? 0) * 1000),
    });
  }

  stop(): void {
    this.stopped = true;
  }

  async runForever(): Promise<void> {
    while (!this.stopped) {
      const nowMs = Date.now();
      for (const registered of this.tasks) {
        if (nowMs < registered.nextRunAtMs) {
          continue;
        }

        const startMs = Date.now();
        try {
          await registered.task.run();
          this.logger.debug(
            {
              task: registered.task.name,
              durationMs: Date.now() - startMs,
            },
            "Scheduler task completed",
          );
        } catch (error) {
          this.logger.error(
            {
              task: registered.task.name,
              error,
            },
            "Scheduler task failed",
          );
          if (this.hooks?.onTaskError) {
            try {
              await this.hooks.onTaskError(registered.task.name, error);
            } catch (hookError) {
              this.logger.warn(
                {
                  task: registered.task.name,
                  hookError,
                },
                "Scheduler error hook failed",
              );
            }
          }
        } finally {
          registered.nextRunAtMs = Date.now() + registered.task.intervalSeconds * 1000;
        }
      }

      await sleep(this.tickSeconds);
    }
  }
}
