-- 022: a link can be started by a Meeps user, and Siege accounts are linkable
--
-- Two changes, both in service of the same thing: Meeps' Settings → Connections
-- screen, which lets a person link their League and Siege accounts without
-- going through Discord at all.
--
-- WHY THE CHALLENGE NEEDED A SUBJECT
--
-- 019 keyed `identity_link_challenges` on `discord_user_id`, because `/link` was
-- the only way to start one. That is not a shape that generalises: a Meeps user
-- with no Discord account is a real person with a real Riot account, and under
-- the old key the only way to give them a challenge was to invent a fake
-- snowflake for them. So the key becomes `(subject_kind, subject_id)` — "the
-- account we will attach the Riot account to, once they prove it" — and
-- `discord_user` is one value of it rather than the only possibility.
--
-- The uniqueness this preserves is the one 019 wanted: **one outstanding
-- challenge per person**, so starting a second link abandons the first. It is
-- now one per person *per identity system*, which is the same guarantee for
-- everybody who exists in only one of them, and for somebody who exists in both
-- it means their Discord `/link start` and their Meeps link are separate
-- attempts. That is correct — they are separate, and neither one holds a claim
-- on anything (019's note on why a challenge holds nothing still applies).
--
-- WHY r6_ubisoft, AND WHY IT CAN NEVER BE VERIFIED
--
-- 020 gave Siege players their own table keyed on `ubisoftId`. Nothing joined
-- those to a person, so an R6 rank notification could not be routed to the Meeps
-- user it was about — the same gap DN-3 closed for puuids, still open here.
--
-- But Siege has no equivalent of the profile-icon handshake and Ubisoft
-- publishes no OAuth, so there is no mechanism by which anybody can prove an
-- account is theirs. `self_asserted` says exactly that and is deliberately *not*
-- in `VERIFYING_METHODS`: it records what we know (they typed it, and the name
-- resolves to a real profile) without implying anybody checked. Keeping it
-- distinct from `trusted` matters because the two are different facts — a
-- trusted link is a server saying its members trust each other, and a
-- self-asserted one is a provider offering us nothing better.

-- ---------------------------------------------------------------------------
-- Siege accounts are linkable; self-assertion is a recordable non-method
-- ---------------------------------------------------------------------------
--
-- Drop-then-add rather than a guarded add: re-adding an existing constraint name
-- errors, and the pair is idempotent where either half alone is not. migrate.sh
-- runs without ON_ERROR_STOP and records the file as applied either way, so
-- every statement here has to survive a second run.

ALTER TABLE "identity_accounts"
    DROP CONSTRAINT IF EXISTS "identity_accounts_kind_check";
ALTER TABLE "identity_accounts"
    ADD CONSTRAINT "identity_accounts_kind_check"
    CHECK ("kind" IN ('riot_puuid', 'discord_user', 'meeps_user', 'r6_ubisoft'));

ALTER TABLE "identity_accounts"
    DROP CONSTRAINT IF EXISTS "identity_accounts_method_check";
ALTER TABLE "identity_accounts"
    ADD CONSTRAINT "identity_accounts_method_check"
    CHECK ("method" IS NULL
           OR "method" IN ('icon_handshake', 'trusted', 'rso', 'self_asserted'));

-- ---------------------------------------------------------------------------
-- Challenges are keyed on a subject
-- ---------------------------------------------------------------------------

-- The rename carries the existing rows' values with it, so there is no backfill
-- and no window in which a live challenge has no subject.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'identity_link_challenges'
          AND column_name = 'discord_user_id'
    ) THEN
        ALTER TABLE "identity_link_challenges"
            RENAME COLUMN "discord_user_id" TO "subject_id";
    END IF;
END $$;

-- NOT NULL DEFAULT fills the existing rows in the same statement, and every one
-- of them is a Discord challenge because that was the only kind there was. The
-- default is then dropped: it was a backfill device, and leaving it would let a
-- future insert silently claim to be a Discord challenge by saying nothing.
ALTER TABLE "identity_link_challenges"
    ADD COLUMN IF NOT EXISTS "subject_kind" VARCHAR(20)
    NOT NULL DEFAULT 'discord_user';
ALTER TABLE "identity_link_challenges"
    ALTER COLUMN "subject_kind" DROP DEFAULT;

-- Only the two kinds that identify a *person*. A challenge subject is who the
-- Riot account gets attached to on success, and neither a puuid nor a Ubisoft id
-- can be that.
ALTER TABLE "identity_link_challenges"
    DROP CONSTRAINT IF EXISTS "identity_link_challenges_subject_kind_check";
ALTER TABLE "identity_link_challenges"
    ADD CONSTRAINT "identity_link_challenges_subject_kind_check"
    CHECK ("subject_kind" IN ('discord_user', 'meeps_user'));

-- Guarded on the column set rather than on the constraint's existence: the name
-- survives the change, so "does identity_link_challenges_pkey exist" is true
-- before and after and would answer the wrong question.
DO $$
DECLARE
    pk_columns TEXT;
BEGIN
    SELECT string_agg(a.attname, ',' ORDER BY a.attname)
      INTO pk_columns
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'identity_link_challenges'::regclass
       AND c.contype = 'p';

    IF pk_columns IS DISTINCT FROM 'subject_id,subject_kind' THEN
        ALTER TABLE "identity_link_challenges"
            DROP CONSTRAINT IF EXISTS "identity_link_challenges_pkey";
        ALTER TABLE "identity_link_challenges"
            ADD PRIMARY KEY ("subject_kind", "subject_id");
    END IF;
END $$;
