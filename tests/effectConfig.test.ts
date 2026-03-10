import { describe, expect, it } from "vitest";
import { loadEffectConfig } from "../src/config/effectConfig.js";

const BASE_ENV: Record<string, string> = {
  PRIVATE_KEY: `0x${"1".repeat(64)}`,
};

const withEnv = <T>(vars: Record<string, string>, run: () => T): T => {
  const previous = process.env;
  process.env = { ...vars };
  try {
    return run();
  } finally {
    process.env = previous;
  }
};

describe("effect config", () => {
  it("loads defaults with minimal required env", () => {
    const config = withEnv(BASE_ENV, () => loadEffectConfig());
    expect(config.dryRun).toBe(true);
    expect(config.orderPrice).toBe(0.46);
    expect(config.marketSlugPrefix).toBe("btc-updown-5m");
    expect(config.chainId).toBe(137);
  });

  it("throws for invalid boolean env values", () => {
    expect(() =>
      withEnv({ ...BASE_ENV, DRY_RUN: "maybe" }, () => {
        loadEffectConfig();
      }),
    ).toThrow();
  });

  it("throws when builder credentials are partial", () => {
    expect(() =>
      withEnv(
        {
          ...BASE_ENV,
          BUILDER_API_KEY: "k",
        },
        () => {
          loadEffectConfig();
        },
      ),
    ).toThrow(/Invalid primary builder credentials configuration/);
  });

  it("throws when chain id is unsupported", () => {
    expect(() =>
      withEnv({ ...BASE_ENV, CHAIN_ID: "1" }, () => {
        loadEffectConfig();
      }),
    ).toThrow(/CHAIN_ID must be 137 or 80002/);
  });

  it("accepts complete primary and secondary builder credentials", () => {
    const config = withEnv(
      {
        ...BASE_ENV,
        BUILDER_API_KEY: "primary-key",
        BUILDER_API_SECRET: "primary-secret",
        BUILDER_API_PASSPHRASE: "primary-pass",
        BUILDER_API_KEY_2: "secondary-key",
        BUILDER_API_SECRET_2: "secondary-secret",
        BUILDER_API_PASSPHRASE_2: "secondary-pass",
      },
      () => loadEffectConfig(),
    );

    expect(config.builderApiKey).toBe("primary-key");
    expect(config.builderApiKey2).toBe("secondary-key");
  });
});
