# Slash commands in Meeps

**Status:** design, awaiting approval
**Date:** 2026-08-01
**Touches:** Diana (`diana-core`, `diana-discord`, `apps/server`) and Meeps (backend + frontend)

## What we want

Type `/` in a Meeps message box and get the same thing Discord gives you: a
narrowing list of commands, a chip per parameter filled one after another, and
suggestions that fill those chips for you. Run `/summoner`, and Diana's answer
appears in the channel where everybody can see it.

## What is actually in the way

Every one of Diana's 25 commands is a `SlashCommand` whose `execute` takes a
discord.js `ChatInputCommandInteraction`. Three couplings come from that, and
they are not equally expensive.

```ts
const name = interaction.options.getString('name', true); // (1) input
const scope = await getGuildCompetitiveScope(interaction.guildId); // (2) scope
await interaction.editReply({ embeds: [embed] }); // (3) output
```

**(1) Input** is trivial — a handful of getters over a plain object.

**(2) Scope is the real blocker.** Diana scopes by `guildId`. Meeps scopes by
space → squad, through `dianaSquads`. A Meeps request contains no guild
anywhere, so there is nothing to put in `interaction.guildId`, and for
`/livegame` that is fatal: `getSquadIdForGuild(null)` returns no squad, which
returns no results.

`squad_attachments` can be read backwards
(`squad_id → external_id WHERE kind = 'discord_guild'`), but its
`PRIMARY KEY (kind, external_id)` guarantees _one guild → one squad_, not the
reverse. A squad attached to two Discord servers has two competitive scopes and
no single correct answer.

**(3) Output is nearly free, but not free** — and I initially claimed it was.
Meeps does not render Discord embed JSON. It renders Diana's own
`MessagePayload` (`packages/diana-core/src/core/pluginTypes.ts`), which
`EmbedCard.jsx` has consumed since migration `013_messages_embed.sql`. The two
shapes are close but differ in three places:

| Discord `EmbedBuilder.toJSON()` | Meeps `MessagePayload`                       |
| ------------------------------- | -------------------------------------------- |
| `color` (int)                   | `colorHex` (int — same value, different key) |
| `thumbnail: { url }`            | `thumbnailUrl` (flat)                        |
| `footer: { text, icon_url }`    | `footer` (string)                            |

So there is a ~15-line adapter to write, not zero. Everything else —
`title`, `description`, `url`, `fields`, `timestamp` — passes through, and
`EmbedCard.normalizeHex` already handles `colorHex` arriving as a number.

The rendering half of this feature is therefore already built and shipped. That
was a decision made years ago and it pays for itself here.

## Design

### 1. A manifest, derived — never written twice

`cmd.data.toJSON()` already _is_ the description the UI needs: names,
descriptions, parameters, types, required flags, choices, and autocomplete
flags. `GET /api/commands` returns that for an explicit allowlist, behind the
Meeps shared secret.

Meeps caches it the way `dianaSquads` caches squad resolution — Diana is the
authority, Meeps keeps a copy.

**Why not hardcode the list in Meeps.** A client with a baked-in command list
offers commands that stopped existing at Diana's last deploy, and cannot offer
new ones without its own release. Deriving from `toJSON()` also means the
manifest cannot drift from what the commands actually accept, because it _is_
what they accept.

**Subcommands are just a first parameter.** `/leaderboard` has `lp` and `stats`
subcommands; `/leaderboard stats` then requires `board`. Rather than teaching
the UI a second concept, the manifest flattens a subcommand group into a
required first parameter of type `choice`, and the invocation layer unflattens
it. One chip shape covers everything.

### 2. Invocation

`POST /api/commands/:name` with `{ spaceId, params }`.

A narrow shim implements only what the allowlisted commands actually touch:
`options.get*`, `getFocused`, `guildId`, `user`, and `deferReply` / `editReply`
/ `reply` capture. Roughly 60 lines.

A shim is normally a lie that rots — it fails at runtime rather than at compile
time, so a command that starts reading `interaction.member.roles` breaks in
production and nowhere else. That is bought off by a conformance test that runs
**every allowlisted command** through the shim. If the shim stops being enough,
CI says so before a deploy does.

Scope resolution: `spaceId → squadId` (Meeps already knows this) →
`squad_attachments` reverse lookup → `guildId`. When that lookup does not return
exactly one guild, the command is refused with a stated reason rather than
guessed at — the same fail-closed posture `dianaSquads` takes for an unresolved
space. "Your squad is not attached to a Discord server" and "your squad has no
matches" are different problems with different fixes, and must not both render
as an empty result.

### 3. Suggest

`POST /api/commands/:name/suggest` with `{ spaceId, param, query, params }`.

Diana's existing `autocomplete` handlers run through the same shim, so
`/summoner`'s tag list stays narrowed by the already-chosen name for free.

**One click fills every box it can.** Discord's autocomplete protocol returns
`{name, value}` and therefore _cannot_ express "fill two parameters" — that is a
limit of the protocol, not of our UI, and Meeps is not bound by it. The suggest
response wraps each choice with an optional `fill` map:

```json
{
    "suggestions": [
        {
            "label": "Louis#EUW",
            "sublabel": "Gold II · 142 games",
            "fill": { "name": "Louis", "tag": "EUW" }
        }
    ]
}
```

The `fill` map is built by a small per-command enrichment beside the allowlist,
not inside the Discord command files — those stay untouched and keep working
exactly as they do now. Where no enrichment exists, `fill` is the single focused
parameter, which degrades to Discord's behaviour.

### 4. The result goes into the channel

The command runs, the captured payload is converted to `MessagePayload`, and
Meeps writes it as a message with an `embed`, attributed to Diana, in the
channel the command was run from.

Everyone sees it, it survives a refresh, and it can be replied to — which is
most of the point of running it in a group chat rather than a DM. It also means
zero new rendering: `EmbedCard` already draws this.

### 5. The input

`MessageInput.jsx`'s `@` mention dropdown is most of the interaction already —
it opens upward (`absolute bottom-full`), has arrow keys, Enter/Tab to accept,
Escape to dismiss, and correct `listbox`/`option` roles. The `/` picker is the
same component's shape, and a `/` button sits beside GIF in `pill-extras`
opening the same list, scrollable.

**`/` only triggers at position 0 of an empty input.** Mid-message it is just a
slash — people type URLs and "and/or", and a picker that ambushes them there is
worse than no picker.

**Chips are real inputs, not a faked caret.** Discord renders its chips inside
one text box with a synthetic cursor. Reproducing that in a `<textarea>` means
hand-rolling caret position, hit-testing and selection. A row of small
`<input>`s — one per parameter — gets tab order, focus, and screen-reader
behaviour from the platform instead.

```
┌────────────────────────────────────────────────┐
│ /summoner   [name: Louis ]  [tag: …          ] │
└────────────────────────────────────────────────┘
                  filled          focused ↑
        ┌──────────────────────────────────┐
        │ Louis#EUW    Gold II · 142 games │   ← suggest, anchored to
        │ Louis#NA1    Silver I · 30 games │      the focused chip
        └──────────────────────────────────┘
```

Keys: Tab/Enter next chip, Shift-Tab previous, Backspace on an empty chip goes
back one, Escape abandons command mode and restores the plain textarea with the
typed text intact. Optional parameters render dimmer and are skippable; Enter on
the last required one sends.

The composite serialises to `{ command, params }` — a structured payload, never
a reconstructed `/summoner name:Louis tag:EUW` string. There is no parser to get
wrong and nothing to escape.

## What is exposed, and what is not

The allowlist is explicit rather than "everything except", so a command added to
Diana is invisible in Meeps until somebody deliberately opens it. Fail closed.

**Exposed (10).** `/summoner` `/leaderboard` `/champion` `/compare` `/livegame`
`/iotw` `/mvp` `/wrapped` `/add` `/remove`

The first eight answer a question about the squad. `/add` and `/remove` mutate
the roster and are gated on space membership — the Meeps-side equivalent of
being in the guild.

**Excluded on correctness, not preference:**

- **`/link`, `/unlink`** — these bind a Riot account to a **Discord user id**.
  The shim's actor is a _Meeps_ user id, so exposing them would write a Meeps id
  into `identity_link_challenges.discord_user_id` and silently corrupt identity
  rows. There is no version of this that is safe without a Meeps-native identity
  flow, which is its own piece of work.
- **`/setchannel`, `/config`, `/apex-channel`** — these configure how Diana
  posts _to Discord_. Running them from Meeps changes a different product's
  delivery settings.
- **`/help`, `/ping`, `/apex-help`** — `/help` renders `</name:id>` command
  mentions, which are Discord chips and meaningless anywhere else.
- **`/privacy`** — a personal decision keyed on puuid via `identity_accounts`.
  It has its own route already and deserves a real Meeps surface rather than a
  command.
- **The remaining `/apex-*`** — a different bot (`pathfinder` botKey) and a
  different plugin. Not excluded on principle; just not in this slice.

## Risks

- **The shim is the load-bearing assumption.** If a command reaches for
  something it does not implement, the conformance test is the only thing
  standing between that and a production 500. That test is not optional.
- **Squads with two Discord guilds** get a refusal rather than a result. Correct,
  but it will read as a bug to whoever hits it, so the message has to say what to
  do about it.
- **`/livegame` calls Riot live.** Running it from Meeps adds a call path that
  was previously rate-limited by Discord's own 3s command cooldown. The
  invocation route needs its own cooldown; roadmap §9 needs a line.
- **`/add` and `/remove` are writes** reachable by any space member. That is the
  same trust boundary as the Discord guild, but it is worth stating out loud
  rather than inheriting by accident.

## Shipping order

1. **Diana:** manifest route, shim, conformance test over all 10, embed →
   `MessagePayload` adapter, scope resolution, suggest route with `fill`.
2. **Meeps backend:** command proxy, result → message with embed, manifest
   cache.
3. **Meeps frontend:** `/` trigger, picker, GIF-row button, chip row, suggest
   client.

Steps 1 and 2 are independently testable. Step 3 is where the design either
feels like Discord or does not, so it is last and gets the most iteration.
