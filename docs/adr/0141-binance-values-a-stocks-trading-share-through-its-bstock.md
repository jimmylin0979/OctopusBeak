# Binance values a Stocks Trading share through its bStock

Status: accepted

Builds on [ADR 0084](0084-binance-declares-bounded-trade-history.md), whose valuation rule this extends.

Binance Stocks Trading holds a US-listed share in the funding wallet under its internal asset code: `EQ_` plus the ticker, such as `EQ_CRCL` ([Stocks Trading user streams](https://developers.binance.com/en/docs/catalog/advanced-trading-stocks-trading/api/ws-streams/user-streams): "the internal asset code with an `EQ_` prefix … Strip the `EQ_` prefix to match a symbol used elsewhere"). Such a share has no spot market, so ADR 0084's USDT routes find no price for it. Binance also lists a bStock token for many of these tickers, such as `CRCLB` on `CRCLBUSDT`. Its Stocks Trading API mints the token from the share and redeems it back, and `GET /sapi/v1/equity/market/tokenized-assets` states each pairing as `underlyingEquitySymbol`, `assetCode` and `multiplier`.

**A held `EQ_` share is priced at the USDT price of the bStock that this list pairs with its ticker at a valid multiplier of exactly 1, then converted with MAX's `usdttwd` as before.**

- The quote keeps the substitution as its first component, `binance:tokenized:CRCL=CRCLB` at `1`, ahead of the bStock's own spot components, so the valuation shows that a token's price stands in for the share.
- The list is a `MARKET_DATA` endpoint: the request carries the API key and is not signed. It is read only when a wallet holds an `EQ_` asset.
- A row whose ticker cannot follow `EQ_` in an asset code, such as `BRK.B`, is skipped rather than failing the list.
- A share whose ticker has no bStock, whose multiplier is not 1 or not valid, or whose list cannot be read stays unvalued in its own units instead of failing the run, as a missing `usdttwd` does.
- Asset codes may join runs of letters and digits with single underscores, so `EQ_CRCL` is read rather than rejected as a malformed response.

Live verification on 2026-11-14 with the project owner's account: the funding wallet held `EQ_CRCL`, the list paired `CRCL` with `CRCLB` at multiplier `1`, and `CRCLBUSDT` (60.36) sat inside the Stocks Trading quote for `CRCL` (bid 61, ask 62, in USD).

## Considered options

- **Use the Stocks Trading quote (`/sapi/v1/equity/market/quote`).** Rejected for now: it answers in USD with a bid and an ask, not a last price, and the source has no USD-to-TWD rate, only `usdttwd`.
- **Derive the token as the ticker plus `B`.** Rejected: a naming habit, not something Binance states; the list is the stated pairing.
- **Apply any multiplier.** Rejected for now: on 2026-11-14 about 30 of the 105 tokens listed a valid multiplier slightly above 1 (such as `1.00077822`), which looks like accrued dividends, but Binance does not document whether the token price divides or multiplies by it.

## Consequences

- A share is valued at its bStock's spot price, which can drift from the share's own market, most visibly while the US market is closed.
- The share is still recorded with the source's crypto security type; classifying `EQ_` holdings as equities is a separate decision.
