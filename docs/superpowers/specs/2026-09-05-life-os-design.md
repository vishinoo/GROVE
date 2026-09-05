# Grove as a Life OS — design

**Status:** implemented (engine); device abilities not yet wired.
**Date:** 2026-09-05

## What changed

Noctus was Grove's brain, catalogue, executor, identity and OAuth broker. It is
now only the last two, plus a scheduler. The agent side is gone.

The reason is arithmetic. The catalogue held 74 built-in agents; counted by
category they were 15 Marketing, 10 Operations, 8 Finance, 7 CX, 7 E-Commerce,
6 Sales, 5 Strategy. Three of the seventy-four resembled anything a person does
with their own day. Browsing that was never going to be how you use something
you talk to while walking. Indy, the conversational tier, was capped at two
messages an hour, which is not a budget you can hold a conversation inside.

## The model

**Abilities** (`src/lib/abilities.ts`) — a small fixed set of functions with
schemas. Adding one is writing a function, not installing an agent. Each
declares `where`:

- `server` — Noctus can run it at 07:00 with the phone in a drawer, and push.
- `device` — needs the phone awake. No server can play a song into your glasses.

That line decides what can ever be scheduled, and the UI states it rather than
letting a briefing silently not arrive.

**Sparks** (`src/lib/sparks.ts`) — a saved sentence, an ability, and a
recurrence. Created only when the sentence carried a time. Everything else runs
once and is forgotten.

**Memory** (`src/lib/memory.ts`) — at most 40 durable facts, each capped, sent
whole in every prompt. No embeddings and no retrieval step: at this size the
cheapest correct thing is to send all of it. Facts are extracted locally by
keyword, are readable and deletable, and are the only thing that ever syncs.
Raw transcripts stay on the phone, as `transcript.ts` always promised.

## Two decisions that stay local

`detectActIntent` (should this cause something to happen) and `parseSchedule`
(should it keep happening). Both keyword-based, both biased toward no, neither
ever delegated to a model. A false negative costs one sentence. A false
positive sends mail you did not write, or wakes you at seven every morning for
something you asked once.

## Not done yet

- Device abilities are declared `wired: false` and say so rather than failing
  silently. Calendar and Reminders need `expo-calendar`; Music needs a native
  module like `grove-remote`.
- `/api/chat/light` on Noctus, so the provider key stops shipping in the bundle.
- `/api/grove/brief` — the one server ability, and the scheduler that runs it.
- Push delivery for scheduled sparks.
