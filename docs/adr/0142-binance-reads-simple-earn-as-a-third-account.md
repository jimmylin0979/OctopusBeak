# Binance reads Simple Earn as a third account

Status: accepted

Amends [ADR 0084](0084-binance-declares-bounded-trade-history.md), which left Earn out of scope. A person who keeps most of their Binance assets in Simple Earn saw only the spot and funding wallets, so the holdings looked nearly empty.

- **A third Crypto financial account, `earn`,** joins `spot` and `funding`. Each has its own balance, so Earn is not folded into spot.
- **Source.** `GET /sapi/v1/simple-earn/flexible/position` (`totalAmount`) and `GET /sapi/v1/simple-earn/locked/position` (`amount`), both signed USER_DATA reads available to a read-only key, paged with `current` and `size` 100. Positions of one asset are summed into one holding.
- **No double count.** The `LD`-prefixed mirror of Earn in the spot account is still dropped; the Earn account reports those positions itself.
- **Failure.** Holdings are complete snapshots, so an unreadable Earn response fails the run instead of silently reporting zero.
- **Still out of scope:** futures, margin, Alpha, staking and Earn history (subscriptions, redemptions, rewards). A spot-to-Earn subscription therefore shows as a spot balance drop that the Bounded trade history does not explain, which ADR 0084 already allows.
- **Valuation** is unchanged: Binance USDT price times MAX `usdttwd`.
