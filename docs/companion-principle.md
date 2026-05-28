# The Companion Principle — implementation reference

> Canonical principle doc lives in Notion: page `35bdfeff-1b02-8116-ba1a-dceca4e74def`
> ("🦕 The companion principle — a wee dinosaur of one's own") under Bonnie Bothy Cloud.
> **This file is the implementation reference** — schema, endpoints, and what's locked
> vs. what's still open. When the two disagree, the Notion page is the source of truth
> for *intent*; this file is the source of truth for *what the code actually does*.

Shipped: **Wave Cairn Companions Foundation** (28 May 2026) — foundational scaffold only.
Illustration + animation are Amanda's work, not in this wave.

---

## What's locked (do not re-litigate — implement against these)

- **Companions live in a Zoo when the device is closed.** Fed, content, playing with
  friends, no stress. This solves the Tamagotchi-anxiety problem at the architecture
  level. **There is no feeding requirement, ever.** Never show "your pet is hungry" /
  "your pet misses you."
- **The user picks and keeps pet(s).** The pet travels with the user on the device and
  returns to the Zoo on close. Same pet across sessions, devices, and time — unless the
  user switches.
- **Names live on the accessory layer** (collar tag, jersey number, shorts label). No
  accessory = no visible name (the user may still hold a private `custom_name`). The
  naming surface *is* the kit.
- **Cosmetic only, free.** No paid accessories, no premium tier, no stats, no power-ups,
  no benefits. Free forever. Period.
- **User-requested species** via a small form. Cultural representation is explicitly
  welcomed and prioritised. The team reviews and adds quarterly if feasible.
- **The 1D / 2D / 3D dimension axis.** The same pet renders three ways, switchable
  anytime: 1D (flat, like a child's drawing — paper, marker, charming wobble), 2D
  (polished illustrated character), 3D (immersive rendered model). Name + accessory +
  identity persist across dimensional switches. (New in this wave.)
- **Companions travel into The Cairn.** (Open question, decided 28 May 2026: yes.)
- **The magic move — user-uploadable 1D pets.** A user uploads a child's drawing (theirs,
  their child's, their grandmother's) and it becomes a unique-to-them 1D companion. The
  Zoo holds personal art alongside professional illustration without ranking them. The
  wobble of the drawing *is* the feature — we never auto-smooth it.

---

## Schema (Cairn Supabase project `mzjvcntzcfagasxcnuye`)

Migration: `migrations/20260528_006_companions_zoo_schema.sql`.

| Table | Purpose |
|---|---|
| `companions` | Registry of available species. Public read. `status` ∈ `live` / `requested` / `in-illustration`. Seeded with 8 starter species (placeholder `asset_paths`). |
| `user_companions` | A user's pet(s). `companion_id` is `NULL` for a user-uploaded 1D pet (`is_user_uploaded=true`, `user_uploaded_asset_path` set). `status` ∈ `active` / `in_zoo` / `retired`. Never hard-deleted — retired pets are the user's memory. |
| `companion_events` | Append-only audit log. `event` ∈ `picked` / `named` / `accessory_changed` / `dimension_changed` / `returned_to_zoo` / `left_zoo` / `retired` / `uploaded_1d`. Written by the backend (service role). |
| `species_requests` | User-submitted requests for new species. Insertable by any authed user; **team-only reads**. |

**RLS posture.** The backend (web + worker) uses the service-role key and bypasses RLS;
it scopes every query to `req.auth.userId` in code. RLS policies are defence-in-depth for
any direct `authenticated`/`anon` access:

- `companions` — readable by everyone.
- `user_companions` — owner-only select/insert/update (`user_id = auth.uid()`).
- `companion_events` — owner-only select (via join to owned `user_companions`); inserts
  are service-role only.
- `species_requests` — authed users may insert their own; **no** authenticated SELECT
  (team reads via service role only).

A `CHECK` constraint (`user_companions_origin_chk`) enforces "exactly one origin": a
user-uploaded pet must carry an asset path; a registry pet must reference a `companion`.

---

## Backend endpoints (`web/`, mounted in `web/src/server.js`)

All require a Supabase JWT (`requireAuth`) and are per-user rate limited. Responses use
the repo's `{ ok, ... }` / `{ ok: false, error }` shape.

| Method + path | Does |
|---|---|
| `GET /api/companions` | List the pickable registry (`status='live'`). |
| `GET /api/companions/mine` | This user's companions (active + in-zoo + retired), with the joined registry row. |
| `POST /api/companions/pick` | Pick a registry species. Body `{ companion_id, dimension?, name?, accessory? }`. Validates the dimension is in the species' `dimensions_available`. Emits `picked` (+ `named` / `accessory_changed`). |
| `POST /api/companions/upload-1d` | **The magic.** Body `{ image_base64, content_type, name?, accessory? }`. PNG or SVG, ≤5 MB. Runs the image through the existing Cairn safety pipeline (IWF CSAM hash-match + Cloudflare NSFW). A CSAM/flagged result is rejected with a kind message and **no row is created**. Stores to R2 and creates a `is_user_uploaded=true` pet (`preferred_dimension='1d'`). Emits `uploaded_1d`. |
| `POST /api/companions/:id/update` | Change `name` / `accessory` / `dimension`. Emits the matching events. Identity persists across dimension switches. |
| `POST /api/companions/:id/return-to-zoo` | The Goodbye Wave. `status='in_zoo'`, `in_zoo_at=now`. Emits `returned_to_zoo`. |
| `POST /api/companions/:id/leave-zoo` | Welcome back. `status='active'`, `last_active_at=now`. Emits `left_zoo`. |
| `POST /api/companions/:id/retire` | User moves on; pet stays in the Zoo, named + dressed. `status='retired'`. Emits `retired`. |
| `POST /api/species-requests` | Submit a species request. Body `{ species_requested, reason?, cultural_significance? }`. |

**Body-size note.** `upload-1d` mounts an 8 MB JSON parser ahead of the global 32 KB
parser in `server.js` (express.json is idempotent, so the global parser leaves the
already-parsed body untouched).

**Storage.** Uploaded 1D images go to the existing `thecairn-media` R2 bucket under
`companions/<userId>/<uuid>.<ext>` via a new `storeObject({ filePath, key, contentType })`
helper added to both the R2 and stub storage bindings (the existing `storeFrame` is
JPG-only). When R2 isn't configured, the filesystem stub is used (dev parity).

---

## Honest About Who's Building

Where AI is involved in safety-scanning uploaded 1D drawings (Cloudflare Workers AI NSFW
classification + IWF image intercept), that must be stated plainly in the upload UI.

---

## What's open / recommended follow-ups

- **Frontend** (`/zoo`, `/zoo/pick`, `/zoo/upload`, `/zoo/request`, persistent corner
  companion, the Goodbye-Wave client trigger) lives in `thecairn-app` — **not shipped in
  this wave** (separate repo; see ship report for the router-tagging note).
- **Illustration / animation pipeline** — Amanda's work. `asset_paths` are placeholders.
- **SVG sanitisation.** Uploaded SVG is currently rejected only for obvious active content
  (`<script>`, `javascript:`, `on*=` handlers). Before SVG is ever served *inline* (vs via
  `<img>`), add a full server-side sanitiser (e.g. DOMPurify). Tracked as a security
  follow-up.
- **Alice-in-Wonderland big-companion mechanic** (Bluey-in-a-bowl-on-wheels) — separate
  wave; the schema leaves room for it.
- **Quarterly species-addition admin** — review `species_requests`, promote to
  `companions`.
- **Inter-pet hellos / personality moments** — animation hooks; stubbed for now.
- **Data retention** (Data Earns Its Keep): propose a rolling TTL for `companion_events`;
  retired companions kept indefinitely; rejected upload attempts cleared after a window.
  Amanda decides the windows.
