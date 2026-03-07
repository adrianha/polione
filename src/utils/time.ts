export const sleep = async (seconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};

export const unixNow = (): number => Math.floor(Date.now() / 1000);

export const getNextEpochTimestamp = (nowSec: number, intervalSeconds: number): number => {
  return Math.floor(nowSec / intervalSeconds) * intervalSeconds + intervalSeconds;
};

export const getCurrentEpochTimestamp = (nowSec: number, intervalSeconds: number): number => {
  return Math.floor(nowSec / intervalSeconds) * intervalSeconds;
};

export const secondsUntil = (targetUnix: number, nowUnix: number): number => {
  return targetUnix - nowUnix;
};
