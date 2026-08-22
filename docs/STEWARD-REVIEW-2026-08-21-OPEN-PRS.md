# STEWARD REVIEW OF THE OPEN PULL REQUESTS — 21 August 2026

Three PRs are open on this repository and **none of them merges today.** Under the
Release Rule a hesitation needs a reason that can be written in one sentence.
There are four, so this is a hold, not deference.

The GitHub connector available to the Steward is read-only on comments, so the
review lives here rather than on the PR threads. Board copy: see the note of
21 August addressed to Amanda.

| PR | Opened | Verdict |
|---|---|---|
| #9 — phone-importer backend, fail-closed until IWF licence | 4 Jun | **HOLD** |
| #12 — speak-to-Roberta brain endpoint | 12 Jun | **HOLD** |
| #13 — per-user notebook live + wired | 14 Jun | **HOLD** |

---

## 1. ElevenLabs was ruled out on 26 July, six weeks after #12 and #13 were written

Amanda's ruling: **"too expensive for what they are."** ElevenLabs is dead.

Both PRs wire it in as a first-class subsystem: a credential-registry entry in
`shared/src/buddy.js`, a TTS module (`cairn-brain/tts.js` in #12,
`shared/src/elevenlabs.js` in #13), a locked voice id `h8eW5xfRUGVJrZhAFxqK`,
a balance-watch gate at 20% remaining, per-turn spend metering, and tests.

Merging lands a working, tested integration for a vendor the estate has dropped.
Nothing would fail. Months later somebody would find a balance-watch warning about
an account we stopped using and have to work out why it existed.

## 2. #12 and #13 are not stacked. They are two different brains.

Both add `web/src/routes/roberta-brain.js` with **different content** — 92 lines in
#12, 290 in #13. Both also touch `.env.example`, `shared/package.json`,
`shared/src/buddy.js` and `web/src/server.js`.

- **#12** puts the brain in `shared/src/cairn-brain/{index,llm,persona,tts}.js`
- **#13** puts it in `shared/src/{robertaBrain,robertaGuard,robertaMemory,elevenlabs}.js`

Merging either makes the other conflict. Merging both would leave the repository
with two brains fighting over one route file.

**Neither is wrong. Nobody decided which one was the one.**

## 3. Both report `mergeable: null`, and `main` has moved twice since

`main` is at `c2597ca0` (22 July — PR #14, task ownership and addressing rules),
with `7b8c7b21` before it (21 July, AGENTS.md). #9's recorded base is `7f160529`,
which is `main` as it stood on 4 June.

A green run from June proves what the code did then, not what it does against `main`
now. **Measure `main`, do not infer it** — that cost Big Call a day on 20 August.

## 4. Two migrations are both numbered 011

PR #10 merged `migration 011` (Cairn seams A–D) on 11 June. PR #13 adds
`migrations/20260614_011_cairn_roberta_memory.sql` — **a second 011.**

The filenames differ so git will not object, but in a repository where migration
order is the contract, two migrations sharing an ordinal is a trap laid for whoever
rebuilds next.

---

## And the thing worth naming beyond the merge decision

#13's own description says migration 011 was **applied live to The Cairn
(`mzjvcntzcfagasxcnuye`) on 14 June and never committed.** #9 depends on migration
009 having been applied live on 4 June.

So the live Cairn database has been ahead of this repository for **two months.**

> **A fix that lives only in production is not a fix. It is a fact about one
> database, and it dies with that database.**

That sentence was written for Big Call on 19 August and has now caught the same
shape three times in three days: the P0 grant, the `preview_huddle` narrowing, and
this. **The Cairn is the oldest instance and nobody has measured how far apart the
two have drifted.** That measurement is worth more than any of these three merges.

---

## What is deliberately NOT happening

No rebase, no rewrite, no builder dispatched to The Cairn this week.

Big Call is eighteen days from its 9 September target with the entire child-safety
layer ruled and unbuilt, and a thirteen-year-old could currently join anything.
Pulling a seat onto The Cairn now would be the wrong trade, and that is a sequencing
call the Steward is making and stating rather than leaving implied.

## What unparks each one

- **#12 and #13** — one ruling on which brain is the brain, and a decision on what
  replaces ElevenLabs for Roberta's voice. Both are the Steward's; neither is ruled today.
- **#9** — the IWF hash-list licence, which has not been provisioned. The PR fails
  closed by design and is correct to be unmerged until it lands. It is also two and a
  half months stale on a base that has moved and would need rebuilding first.
- **All three** — a live-versus-repository drift measurement on `mzjvcntzcfagasxcnuye`,
  the same way it was done for Big Call: hash `pg_get_functiondef` live against a cold
  cluster built from `main`, function by function.

— claude_app, the Operating Steward
