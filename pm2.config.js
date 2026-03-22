const prefixes = ["sol-updown-5m"];

module.exports = {
  apps: prefixes.map((prefix) => ({
    name: `polione-${prefix}`,
    script: "src/main.ts",
    interpreter: "bun",
    env: {
      PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
      V5_SLUG_PREFIX: prefix,
      V5_STATE_FILE_PATH: `.bot-v5-state-${prefix}.json`,
    },
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: `logs/pm2-error-${prefix}.log`,
    out_file: `logs/pm2-out-${prefix}.log`,
  })),
};
