"""
Main entry point – simple workflow for Polymarket Trading Bot.

Workflow (does not run without PRIVATE_KEY + real impl):
  1. Load config (env) → init bot (PolyClient + optional PolyRelayerClient)
  2. Find next active 5m market (slug → Gamma API)
  3. Place limit orders (Up + Down) via CLOB
  4. After market resolves: merge tokens or redeem positions via relayer
"""
import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

try:
    from polymarket_bot import PolymarketBot
except ImportError:
    from src.service.polymarket_bot import PolymarketBot


def workflow():
    # --- 1. Config & init ---
    private_key = os.getenv("PRIVATE_KEY")
    if not private_key:
        print("PRIVATE_KEY not set – workflow stops (no signing).")
        return

    host = os.getenv("HOST", "https://clob.polymarket.com")
    chain_id = int(os.getenv("CHAIN_ID", "137")) if os.getenv("CHAIN_ID") else 137
    signature_type = int(os.getenv("SIGNATURE_TYPE", "2")) if os.getenv("SIGNATURE_TYPE") else 2
    funder = os.getenv("FUNDER")

    bot = PolymarketBot(
        host=host,
        private_key=private_key,
        funder=funder,
        chain_id=chain_id,
        signature_type=signature_type,
    )
    if not bot.poly_client or not bot.poly_client.is_available():
        print("PolyClient not available – workflow stops.")
        return

    # --- 2. Find next active market ---
    market = bot.find_next_active_market()
    if not market:
        print("No next active market – workflow stops.")
        return

    token_ids = bot.get_token_ids(market)
    if not token_ids:
        print("No token IDs from market – workflow stops.")
        return

    # --- 3. Place limit orders (Up + Down) ---
    price = float(os.getenv("ORDER_PRICE", "0.46"))
    size = float(os.getenv("ORDER_SIZE", "5.0"))

    up_order = bot.place_limit_order(
        token_id=token_ids["up_token_id"],
        side="BUY",
        price=price,
        size=size,
    )
    down_order = bot.place_limit_order(
        token_id=token_ids["down_token_id"],
        side="BUY",
        price=price,
        size=size,
    )

    if up_order:
        print("Up order placed.")
    if down_order:
        print("Down order placed.")

    # --- 4. After market resolves (merge or redeem via relayer) ---
    if bot.relayer_client and bot.relayer_client.is_available():
        condition_id = market.get("condition_id") or market.get("conditionId")
        if condition_id:
            # Merge: turn 1 Up + 1 Down back into 1 USDC
            # bot.merge_tokens(condition_id=condition_id, amount=1_000_000)
            # Or redeem winning side only
            # bot.redeem_positions(condition_id=condition_id, index_sets=[1, 2])
            print("Relayer available – merge/redeem would run here (condition_id present).")
    else:
        print("Relayer not configured – skip merge/redeem.")


if __name__ == "__main__":
    workflow()
