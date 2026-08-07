-- ====================================
-- Migration 023: Rainbow Six: Siege per-match messages, and the call budget
-- that makes them possible
--
-- Part B of Meeps' docs/r6-events-and-post-match.md. Two things, and the second
-- one is the reason the first is buildable at all.
--
-- WHAT PART B NEEDS FROM THE SCHEMA
--
-- Siege has no match record — the provider returns season-cumulative counters,
-- so "one match completed" is *inferred* from the counters moving by exactly
-- one between two polls. 020 stored kills, wins and losses; `toSnapshot`
-- already reads deaths into `R6StatSnapshot` and simply never persisted them,
-- so a per-match card could say kills and not K/D. `deaths_snapshot` closes
-- that. `abandons_snapshot` is captured at the same time because r6data
-- reports `abandon`/`abandons` and dropping it makes an abandoned match
-- indistinguishable from a match that never happened — an abandon moves RP
-- while wins and losses both stand still.
--
-- WHY THERE IS A BUDGET LEDGER IN A SCHEMA MIGRATION
--
-- The inference only resolves a single match if the poll window is roughly one
-- match wide (a Siege ranked game runs 25-35 minutes), so the feature wants a
-- ~5-minute cadence. The r6data plan allows **3,000 calls per month** across
-- **3 tracked players**. A 5-minute cron costs 8,760 ticks x 1 call per player
-- = 26,280 calls/month — an order of magnitude over.
--
-- The hourly default 020 shipped costs 2,190 and does fit, but only because this
-- migration's companion change dropped the redundant accountInfo request: at the
-- two calls per player it used to make it cost ~4,380 and was already over the
-- plan, silently, because nothing counted. An hour also spans two or three games,
-- so it resolves almost nothing.
--
-- So the cadence cannot be a fixed cron interval. The whole month's allowance is
-- about 31 polls per player per day, which spent at five minutes is ~2.5 hours of
-- coverage — and less than that in practice, because some of it goes on noticing
-- that a session started. It is enough *only* if the calls are spent while
-- somebody is playing. That makes the cadence per-player and stateful — hence the
-- two columns below on `r6_players` — and makes the monthly cap an invariant
-- something has to enforce, rather than an assumption in a comment.
-- `r6_api_budget` is that enforcement: every r6data request counts against the
-- current UTC month, and the poller widens its own intervals as the month's
-- spend runs ahead of the month's elapsed time.
--
-- migrate.sh runs psql without ON_ERROR_STOP and records the file as applied
-- either way, so every statement here is idempotent and assumes nothing about
-- the statement before it.
-- ====================================

-- ---------------------------------------------------------------------------
-- The two counters Part B needs
-- ---------------------------------------------------------------------------
--
-- Nullable with no default, exactly like 020's three: NULL means "no baseline
-- captured yet", which is not the same claim as 0 and is rendered differently.
-- A player tracked before this migration therefore reports a null K/D on their
-- next match card and a real one on the card after, rather than a fabricated
-- 0 deaths.
ALTER TABLE "r6_players" ADD COLUMN IF NOT EXISTS "deaths_snapshot"   INT;
ALTER TABLE "r6_players" ADD COLUMN IF NOT EXISTS "abandons_snapshot" INT;

-- ---------------------------------------------------------------------------
-- Per-player poll cadence
-- ---------------------------------------------------------------------------
--
-- The cron becomes a fixed fast heartbeat and *these two columns* become the
-- schedule. A player is in one of two states:
--
--   active  — something moved recently, so poll every 5 minutes
--   idle    — poll every few hours, purely to notice that a session started
--
-- Deliberately two states and not a backoff ladder, which is the obvious design
-- and the wrong one here. A ladder widens after N consecutive quiet polls, and
-- within a Siege session *most* polls are quiet: a 30-minute match seen at
-- 5-minute intervals is one poll with movement and six without. Any quiet
-- threshold low enough to ramp down cheaply after a session is also low enough
-- to ramp down in the middle of one, which loses exactly the resolution the
-- fast cadence was bought for.
--
-- `active_until` sidesteps that: movement extends a fixed window forwards, so
-- quiet polls inside a match cost nothing and the window closes on its own an
-- hour after the last thing that actually happened.
ALTER TABLE "r6_players" ADD COLUMN IF NOT EXISTS "active_until" TIMESTAMPTZ;

-- Deliberately *not* `"lastUpdated"`. That column means "when did this row's
-- rank last change", and the poller needs "when did I last spend a call on this
-- player" — which is most of the time, and is the only one a budget can be
-- reasoned about from. NULL means never polled, which is always due.
ALTER TABLE "r6_players" ADD COLUMN IF NOT EXISTS "last_polled_at" TIMESTAMPTZ;

-- The poller's only read: which players are due now, cheapest first.
CREATE INDEX IF NOT EXISTS "idx_r6_players_last_polled_at"
    ON "r6_players" ("last_polled_at" ASC NULLS FIRST);

-- ---------------------------------------------------------------------------
-- The monthly call ledger
-- ---------------------------------------------------------------------------
--
-- One row per UTC month, keyed 'YYYY-MM'. Deliberately a table and not an
-- in-process counter: the bot restarts (deploys, crashes, the supervisor), and
-- a counter that resets on restart enforces nothing at all — the failure mode
-- of a redeploy loop would be to spend the month's quota in an afternoon.
--
-- `calls` counts *requests issued*, not requests that succeeded. A 429 or a 500
-- consumes quota at the provider just as a 200 does, and a ledger that only
-- counted successes would accelerate exactly when the provider was pushing
-- back.
--
-- Old months are kept. Twelve rows a year is free, and being able to say what
-- last month cost is the only way to tell a cadence change from a usage change.
CREATE TABLE IF NOT EXISTS "r6_api_budget" (
    "period"     CHAR(7)     PRIMARY KEY,
    "calls"      INT         NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
