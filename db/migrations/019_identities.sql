-- 019: unified identity - one person, many linked accounts (DN-3)
--
-- The other half of DN-3, and the join between the two halves of the product.
-- Diana knows puuids; Meeps knows its own users; nothing currently connects
-- them. That is why Session Recap can say "Louis left after game 5" and "best
-- game: Aidan's Warwick" but cannot say they are the same person, and why the
-- Session Curve cannot compute its one uncopyable dimension - win rate by
-- whether the player was in voice (roadmap §8.1).
--
-- migrate.sh runs psql without ON_ERROR_STOP and records the file as applied
-- either way, so every statement here must be idempotent and must not assume
-- the statement before it succeeded.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- A bare identity with attachments hanging off it, exactly the shape DN-2 used
-- for squads. Reused rather than reinvented because the problem is the same one
-- - "this external thing belongs to that internal thing" - and so is the
-- resolution query.
--
-- The identity carries no name. There is no field here that would not be a
-- worse copy of something an attachment already knows: Discord has the display
-- name, Meeps has the display name, Riot has the game name, and all three
-- change without telling us.
CREATE TABLE IF NOT EXISTS "identities" (
    "identity_id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PRIMARY KEY (kind, external_id) is the load-bearing constraint, as it was for
-- squad_attachments: one Riot account belongs to exactly one person, so
-- puuid -> identity is total and single-valued and no read path has to decide
-- what an account linked to two people means.
--
-- No foreign key to `summoners`. A person can link a Riot account Diana has
-- never seen play, and refusing that link - or worse, cascading it away when a
-- summoner is removed from a squad - would break identity for exactly the
-- casual player whose voice presence the session features care about.
CREATE TABLE IF NOT EXISTS "identity_accounts" (
    "kind"        VARCHAR(20) NOT NULL,
    "external_id" VARCHAR(200) NOT NULL,
    "identity_id" UUID NOT NULL
                  REFERENCES "identities" ("identity_id") ON DELETE CASCADE,
    -- Nullable, and the null is meaningful. An unverified link is a real and
    -- useful state: a friend group that trusts each other should not have to do
    -- a handshake. But it must stay distinguishable, because auto rank roles
    -- and anything else that grants a privilege may only trust a verified one.
    "verified_at" TIMESTAMPTZ,
    "method"      VARCHAR(20),
    "linked_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("kind", "external_id")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'identity_accounts_kind_check'
    ) THEN
        ALTER TABLE "identity_accounts"
            ADD CONSTRAINT "identity_accounts_kind_check"
            CHECK ("kind" IN ('riot_puuid', 'discord_user', 'meeps_user'));
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'identity_accounts_method_check'
    ) THEN
        ALTER TABLE "identity_accounts"
            ADD CONSTRAINT "identity_accounts_method_check"
            CHECK ("method" IS NULL
                   OR "method" IN ('icon_handshake', 'trusted', 'rso'));
    END IF;
END $$;

-- The reverse lookup: "every account belonging to this person". It is what
-- resolution does on every call - meeps_user -> identity -> riot_puuids - so it
-- is the read this table exists to serve.
CREATE INDEX IF NOT EXISTS "idx_identity_accounts_identity"
    ON "identity_accounts" ("identity_id");

-- ---------------------------------------------------------------------------
-- Verification challenges
-- ---------------------------------------------------------------------------
--
-- The profile-icon handshake: set your icon to N, and Diana reads summoner-v4
-- to confirm. RSO is not granted (roadmap gate 5), so this is the fallback that
-- actually ships.
--
-- One outstanding challenge per Discord user, not per puuid. Keying on the
-- puuid would let two people race a handshake for the same account, and the
-- second to finish would win somebody else's link.
CREATE TABLE IF NOT EXISTS "identity_link_challenges" (
    "discord_user_id" VARCHAR(30) PRIMARY KEY,
    "puuid"           VARCHAR(200) NOT NULL,
    "game_name"       VARCHAR(100) NOT NULL,
    "tag_line"        VARCHAR(10)  NOT NULL,
    "region"          VARCHAR(20),
    -- The icon they must set. Chosen to exclude whatever they have on now, so
    -- that "verification" cannot pass on a player who changed nothing.
    "required_icon"   INTEGER NOT NULL,
    "expires_at"      TIMESTAMPTZ NOT NULL,
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sweeping expired challenges is a scan by time, not by user.
CREATE INDEX IF NOT EXISTS "idx_identity_link_challenges_expires"
    ON "identity_link_challenges" ("expires_at");

-- ---------------------------------------------------------------------------
-- Trusted linking, per Discord server
-- ---------------------------------------------------------------------------
--
-- Issue #142: "for friend-group servers a trust-based link (no verification) is
-- fine". With this on, /link completes immediately and records
-- method = 'trusted' with verified_at left null.
--
-- Default FALSE, and the default is the point. The setting's blast radius is a
-- stranger claiming somebody else's account, so a server that wants the
-- convenience has to say so. It lives on guild_config rather than on the squad
-- because it is a statement about how much a *room* trusts the people in it,
-- which is the same kind of fact as channel_id and notification_prefs.
ALTER TABLE "guild_config"
    ADD COLUMN IF NOT EXISTS "allow_trusted_links" BOOLEAN NOT NULL DEFAULT FALSE;
