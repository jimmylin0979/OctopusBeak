# Binance reports every wallet the account holds and prices tokenized equities

Status: accepted

Amends the **Accounts** and **Valuation** points of [ADR 0084](0084-binance-declares-bounded-trade-history.md). Its trade-history bound is unchanged.

ADR 0084 reported spot and funding only, so an owner with most of their money in Simple Earn saw almost none of it, and a tokenized equity in the funding wallet had no price. The first live run after the asset-code fix showed both: a Binance account worth about 3,400 USD showed roughly zero.

**Every wallet that holds money is a Crypto financial account named after it.** Spot, Funding and Simple Earn are always reported, even when empty, so an emptied wallet reads as an observed zero. Simple Earn is the sum of the flexible and locked positions of each asset. Cross Margin (its net asset, so a borrowed asset counts nothing) and USDⓈ-M Futures (its wallet balance, without unrealized profit and loss) are reported only when Binance's own wallet list (`/sapi/v1/asset/wallet/balance`) shows a balance there, because an account that never opened them answers their endpoints with an error. Other wallets, such as COIN-M futures, isolated margin and options, are still not reported; a later addition needs its own endpoint and, like these, a decision on how it is valued. Each account's display name is its wallet name, carried as the account number of kind `platform-account`, so the person tells Binance Spot, Funding and Simple Earn apart.

**A tokenized equity is priced from Binance's US-equity quote.** `EQ_CRCL` is the share of the US equity `CRCL`; it has no spot pair, so the USDT routes of ADR 0084 never found it. Its price is the midpoint of the best bid and ask from `/sapi/v1/equity/market/quote`, in US dollars, treated as USDT and converted with MAX's `usdttwd` like every other asset. Both quote lexemes are kept as the valuation's evidence. A share Binance cannot quote, or a request that fails, leaves the holding unvalued rather than failing the run. The security type stays `cryptocurrency` until a second tokenized equity justifies a type of its own.

## Considered options

- **Fold Earn into spot.** Rejected, as in ADR 0084: each wallet has its own balance and history.
- **Query margin and futures on every run.** Rejected: an account without them answers with an error that would fail the whole run.
- **Fail the run when a wallet Binance lists as held is not collected.** Rejected for now: it would turn one unsupported wallet into a failed sync; the wallet stays visible only in Binance.
- **Price equities from a US market-data source.** Rejected as the first choice: Binance's own quote is the price the person can trade at. It remains the fallback if Binance withdraws the endpoint.

## Consequences

- A simple-earn position redeemed or subscribed shows as a balance change in two accounts with no matching movement; Simple Earn subscription and redemption history is not collected, as with ADR 0084's other omissions.
- Existing spot and funding accounts gain a display name; their identity is unchanged.
- Earn rewards, and the interest they represent, are inside the position amount and are not recorded as transactions.
