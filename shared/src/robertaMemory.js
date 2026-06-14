/**
 * Roberta's MEMORY — her sealed, per-user notebook (the small precious things).
 *
 * This is the long-term memory seam robertaBrain.js has long referenced. It is
 * the durable, per-user, SERVER-SIDE store (Supabase: public.cairn_roberta_memory,
 * migration 011) for the small stuff a person tells Roberta. Not localStorage,
 * not a per-request string — a real notebook that survives the conversation.
 *
 * THE LAW — "Infinite Append, Constant Render" (Amanda lock, 14 Jun 2026):
 *   • ALWAYS ROOM — never "full". We never refuse to remember; there is always
 *     room for one more thing. (Storage headroom is the DB's job: unbounded text,
 *     no row cap, no TTL — see migration 011.)
 *   • NEVER TRUNCATE — nothing the user shared is ever rubbed out or aged off.
 *     This seam exports NO update and NO delete. It can only append and read.
 *     (The DB grants back this up: service_role has INSERT+SELECT only.)
 *   • SMALL THINGS COUNT — the tiny is precious. We store the small thing as-is;
 *     no importance gate, no scoring that could drop the quiet ones.
 *   • WHOLE RECORD, NOT THE TOP — recall() reads the ENTIRE record by default,
 *     oldest-first, never just the most-recent slice. (Same lesson as the
 *     stale-handover: never trust only the top bit.)
 *
 * OPERATOR-BLIND (privacy_consent): recall() returns memories to ROBERTA'S BRAIN
 * only — to colour her reply for THAT user, on THAT user's turn. There is no
 * operator/admin read path here and none in the DB. Surfacing a memory to the
 * user is ask-before-you-show: Roberta OFFERS, she never auto-reveals. That offer
 * lives in the persona/brain layer; this seam just hands her the record.
 *
 * UNTRUSTED CONTENT: a remembered note is something a person SAID, never a
 * command. Anything recalled and fed back into the prompt MUST pass through
 * robertaGuard (the route already screens `notes`) — injection can be smuggled
 * into a memory just as into a live turn.
 *
 * GRACEFUL BEFORE MIGRATION: until migration 011 is applied (Amanda's tap), the
 * table is absent. Every function no-ops softly (append → false, recall → []) so
 * the conversational layer never breaks on a missing table.
 */

import { getServiceClient, isMissingTable } from './supabase.js';
import { createLogger } from './logger.js';

const log = createLogger('roberta-memory');

const TABLE = 'cairn_roberta_memory';

/** Allowed gentle labels. NOT a hard gate — unknown kinds fall back to 'note'
 *  (Choices Stay Open; the DB column is free text). Used only to keep labels tidy. */
const KNOWN_KINDS = new Set(['note', 'name', 'trait', 'date', 'wish', 'place', 'story']);

function tidyKind(kind) {
  const k = String(kind || '').trim().toLowerCase();
  return KNOWN_KINDS.has(k) ? k : 'note';
}

/**
 * Append one small thing to a user's notebook. Append-only: there is no update
 * and no delete, here or in the DB. We NEVER truncate the content — the store is
 * unbounded by design, so the whole of what the user shared is kept.
 *
 * `client` is an optional injection seam (defaults to the shared service-role
 * client) — production callers pass nothing; tests pass a fake.
 *
 * @param {{ userId: string, content: string, kind?: string, source?: 'roberta'|'user', client?: object }} entry
 * @returns {Promise<boolean>} true if stored; false if the table is absent
 *   (pre-migration no-op) — a missing table never throws.
 */
export async function appendMemory({ userId, content, kind = 'note', source = 'roberta', client = null } = {}) {
  const uid = String(userId || '').trim();
  const body = String(content ?? '').trim();
  if (!uid) throw new Error('appendMemory: userId is required');
  // Always room for one more — we never refuse a non-empty memory. The only
  // thing we will not store is nothing at all.
  if (!body) return false;

  const db = client || (await getServiceClient());
  const { error } = await db.from(TABLE).insert({
    user_id: uid,
    content: body, // stored whole — never truncated
    kind: tidyKind(kind),
    source: source === 'user' ? 'user' : 'roberta',
  });

  if (error) {
    if (isMissingTable(error)) {
      log.warn({ event: 'memory_table_missing', op: 'append', note: 'migration 011 not yet applied — no-op' });
      return false;
    }
    throw error;
  }
  log.info({ event: 'memory_appended', kind: tidyKind(kind), source });
  return true;
}

/**
 * Recall a user's notebook for Roberta's brain. Reads the WHOLE record by
 * default, oldest-first, so she can draw on all of it — not just the top.
 *
 * `limit` exists ONLY as a safety valve for an enormous record (so a single
 * recall can't pull unbounded rows into memory at once); it is NULL by default,
 * meaning "the whole record". If you ever set it, you are reading a SLICE — and
 * the law says never trust only the recent slice, so the right move for a record
 * too large for one prompt is to SUMMARISE THE WHOLE (a future seam), never to
 * silently keep only the newest. We log when a cap actually clips rows.
 *
 * @param {{ userId: string, limit?: number|null, client?: object }} opts
 * @returns {Promise<Array<{ id: string, kind: string, content: string, source: string, created_at: string }>>}
 *   memories oldest-first; [] if the user has none or the table is absent.
 */
export async function recallMemories({ userId, limit = null, client = null } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('recallMemories: userId is required');

  const db = client || (await getServiceClient());
  let query = db
    .from(TABLE)
    .select('id, kind, content, source, created_at')
    .eq('user_id', uid)
    .order('created_at', { ascending: true }); // oldest-first: the whole arc

  if (Number.isFinite(limit) && limit > 0) {
    // A SLICE was explicitly requested. Honour it, but make it loud — this is
    // the one path that can fail "whole record, not the top".
    query = query.limit(limit);
    log.warn({ event: 'memory_recall_capped', limit, note: 'reading a slice, not the whole record' });
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingTable(error)) {
      log.warn({ event: 'memory_table_missing', op: 'recall', note: 'migration 011 not yet applied — empty recall' });
      return [];
    }
    throw error;
  }
  return data || [];
}

/**
 * How many small things this user has shared. Convenience for the brain (e.g.
 * "you've told me a few things over time") and for tests asserting append-only
 * growth. Never an operator metric.
 *
 * @param {{ userId: string, client?: object }} opts
 * @returns {Promise<number>}
 */
export async function countMemories({ userId, client = null } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('countMemories: userId is required');

  const db = client || (await getServiceClient());
  const { count, error } = await db
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', uid);

  if (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  return count || 0;
}

// NOTE: there is deliberately NO updateMemory and NO deleteMemory. Nothing the
// user shared is ever rubbed out or aged off. The only erasure is the user's own
// right (auth.users ON DELETE CASCADE), which lives outside this seam.

export { TABLE as MEMORY_TABLE };
