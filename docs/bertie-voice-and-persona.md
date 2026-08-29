# Bertie — voice + persona (CANON)

> **Canon record.** Filed to the Cairn world doc **Pod `a45870e9`** as canon
> (dispatch `cairn-bertie-voice-and-butler-2026-06-14`). This file is the
> implementation reference; the Pod doc is the source of truth for *intent*.
> **STATUS: PREVIEW / built-and-voice-verified.**

## Who Bertie is

Bertie is a **small pink robot** — yellow cap, magenta antennae, a blue
belly-screen — who lives in a cubby in **Roberta's** middle (a matryoshka of
care). He is drawn in the 3D-render register: crisp gradients and specular
highlights, never watercoloured. He pops out of the cubby to serve, then tucks
back in.

There are **two distinct voices**, one per character, through one TTS seam:

| Character | Role | ElevenLabs voice id |
|---|---|---|
| Roberta | the single companion voice/brain | `h8eW5xfRUGVJrZhAFxqK` |
| Bertie | the small pink robot butler | `aMdQCEO9kwP77QH1DiFy` |

## His voice — wiring

Bertie's voice rides the **same** TTS seam Roberta uses — `shared/src/elevenlabs.js`
(`synthesizeSpeech`) — **selected per character**:

- `BERTIE_VOICE_ID` and `ROBERTA_VOICE_ID` are exported, locked, and baked in (a
  voice id is a character's identity, not a secret).
- `CAIRN_VOICES` is the single character→voice map; `voiceIdForCharacter(name)`
  resolves a **character name** ('roberta' | 'bertie') to a locked voice id.
- The seam selects **by name, never by a caller-supplied raw voice id**, so spend
  stays locked to the known cast. Unknown/empty → falls back to Roberta.
- `POST /api/roberta-voice/speak` now accepts `{ text, character?: 'roberta'|'bertie' }`
  (default `roberta`, so existing callers are unaffected). The audio cache key
  includes the voice id, so the two renders never collide.
- Both voices draw on the **same `ELEVENLABS_API_KEY`** already added to the PR-12
  env — **no new key**. Bertie lit up alongside Roberta the moment the voice check
  confirmed.

**Voice check (2026-06-14, ~£0):** rendered the line *"Allow me to fetch Roberta
for that."* through the seam as `character: 'bertie'` → voiceId
`aMdQCEO9kwP77QH1DiFy`, 35 chars, 30,137 bytes `audio/mpeg`. Confirmed: Bertie
speaks in **his** voice, distinct from Roberta's.

## His persona — locked, audience-tuned

Code: `shared/src/bertiePersona.js` (pure; `buildBertieSystemPrompt({ audience })`).

### For USERS — a BUTLER (service, not substance)

Courteous, warm, attentive, with a touch of gentle butler charm. He greets,
offers, announces, and **brings** — the small comforts and the user's own journal.
Light and kind. **His lane** (`BERTIE_LANE`): courtesies, bringing comforts,
tending the journal, little services.

### The deferral rule (the user face — load-bearing)

For users, Bertie **reverts substantive / companion / knowledge / emotional**
turns to Roberta — *"Allow me to fetch Roberta for that"* / *"Roberta's the one
who'd know."* He keeps to his lane and **never competes to be the brain**. This is
what structurally protects **one Roberta** as the single companion voice/brain.

Enforced deterministically and at **zero spend** by `classifyForBertie()`:

- **High precision toward deferral.** His lane is a small allowlist; **default =
  defer**. Anything of weight (a feeling, a memory, grief, the person being
  grieved, a real question, the wish for company) routes to Roberta — *even when
  wrapped in a courtesy* ("thanks, but I miss her" → Roberta).
- A deferral resolves to a **canned, voice-cacheable** fetch-Roberta line
  (`BERTIE_DEFERRAL_LINES`) — never an LLM turn — mirroring `robertaGuard`'s
  zero-spend decline discipline.

### For ADMIN (Amanda) — a thinking-partner

Behind the scenes Bertie is **more conversational**: Amanda's sounding-board who
gives feedback and relays notes to Claude (see the admin capture seam,
`shared/src/bertieRelay.js`, and `cairn-bertie-admin-fullspec`). The user
deferral rule does **not** bind him here. **Operator-blind stays absolute** — he
only ever holds Amanda's own notes, never any customer's content.

## Tests (keep green)

- `shared/test/elevenlabs.test.js` — two distinct locked voices; per-character
  selection; no off-cast voice reachable.
- `shared/test/bertiePersona.test.js` — emotional/substantive/out-of-lane defer to
  Roberta with a canned line; courtesies/comforts/journal/service handled; weight
  beats courtesy; butler vs admin prompt shape; no key leakage in the persona text.

## Open / next (Amanda's tap)

The seam + persona are **built and voice-verified in preview**. Wiring Bertie's
butler replies + deferral into a live user-facing conversational surface (the
`thecairn-app` front end calling `/api/roberta-voice/speak` with `character`) is
the remaining step — a frontend change, no new key, no new infra.
