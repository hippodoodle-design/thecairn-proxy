/**
 * Cairn storage + stones spine — the dual-storage backend on LIVE per-account
 * data. Ingest → normal FOLDER (canonical R2 store) → copy-to-STONES (named
 * collections that reference folder items, no blob duplication), with a ~20-step
 * UNDO SPINE. Operator-blind: every helper scopes to one ownerId; there is no
 * admin/all-users path.
 *
 * Pure-ish helpers over a service-role Supabase client (bypasses RLS; ownership
 * enforced in code by filtering owner_id). Schema: migration 009. Until applied,
 * helpers surface { missingSchema: true } via isMissingTable rather than throwing.
 *
 * Dispatch: db871533-9c38-4059-9f43-3ff9ad90e1f0.
 */
import { isMissingTable } from '../supabase.js';

/**
 * THE CAIRNWARD DEPOSIT CONTRACT (HippoDelivery → The Cairn).
 *
 * A finished HippoDelivery rescue batch is handed to the Cairn as a deposit:
 *
 *   {
 *     ownerId: uuid,             // the Cairn account the rescue belongs to
 *     batchId: string,          // HippoDelivery batch reference (idempotency)
 *     items: [{
 *       r2Key: string,          // REQUIRED — the blob already in R2 (EU). The
 *                               // deposit places bytes in R2; the Cairn only
 *                               // records the reference (no re-upload here).
 *       kind?: 'photo'|'video'|'audio'|'document'|'other',
 *       title?: string,
 *       mimeType?: string,
 *       sizeBytes?: number,
 *       capturedAt?: string,    // ISO; original media date when known
 *       metadata?: object,
 *     }]
 *   }
 *
 * depositBatch() lands each item as a folder_items row, idempotent on
 * (owner_id, r2_key) so re-delivering a batch never duplicates. The actual
 * R2 byte placement is HippoDelivery's job (the deposit precondition); this is
 * the LIVE-data-ready landing point for the moment rescues start arriving.
 */

const VALID_KINDS = ['photo', 'video', 'audio', 'document', 'other'];

function normaliseKind(k) {
  return VALID_KINDS.includes(k) ? k : 'other';
}

/** Land a HippoDelivery deposit batch into the account's folder. Idempotent. */
export async function depositBatch(supabase, { ownerId, batchId, items }) {
  if (!ownerId) throw new Error('depositBatch: ownerId required');
  if (!Array.isArray(items) || items.length === 0) {
    return { inserted: [], skipped: 0, missingSchema: false };
  }

  const rows = items
    .filter((it) => it && typeof it.r2Key === 'string' && it.r2Key)
    .map((it) => ({
      owner_id: ownerId,
      source: 'hippodelivery',
      source_batch_id: batchId ?? null,
      kind: normaliseKind(it.kind),
      title: it.title ?? null,
      r2_key: it.r2Key,
      r2_jurisdiction: it.r2Jurisdiction ?? 'eu',
      mime_type: it.mimeType ?? null,
      size_bytes: Number.isFinite(it.sizeBytes) ? it.sizeBytes : null,
      captured_at: it.capturedAt ?? null,
      metadata: it.metadata ?? {},
      status: 'active',
    }));

  if (rows.length === 0) return { inserted: [], skipped: items.length, missingSchema: false };

  // ignoreDuplicates: a re-delivered (owner_id, r2_key) is skipped, not errored.
  const { data, error } = await supabase
    .from('folder_items')
    .upsert(rows, { onConflict: 'owner_id,r2_key', ignoreDuplicates: true })
    .select('id, r2_key, kind, title, status');
  if (error) {
    if (isMissingTable(error)) return { inserted: [], skipped: 0, missingSchema: true };
    throw error;
  }
  return { inserted: data ?? [], skipped: rows.length - (data?.length ?? 0), missingSchema: false };
}

/** The account's folder (canonical store). Active items by default. */
export async function listFolder(supabase, ownerId, { includeTrashed = false } = {}) {
  let q = supabase
    .from('folder_items')
    .select('id, kind, title, r2_key, mime_type, size_bytes, captured_at, status, position, created_at')
    .eq('owner_id', ownerId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: false });
  if (!includeTrashed) q = q.eq('status', 'active');
  const { data, error } = await q;
  if (error) {
    if (isMissingTable(error)) return { items: [], missingSchema: true };
    throw error;
  }
  return { items: data ?? [], missingSchema: false };
}

/** Record a reversible op on the Undo Spine (best-effort; never fails the action). */
export async function recordUndo(supabase, { ownerId, op, targetTable, targetId, before = null, after = null }) {
  try {
    const { error } = await supabase
      .from('undo_log')
      .insert({ owner_id: ownerId, op, target_table: targetTable, target_id: targetId ?? null, before, after });
    if (error && !isMissingTable(error)) {
      // Surface non-schema errors to the caller's logs but don't throw — the
      // primary action already succeeded.
      return { recorded: false, error };
    }
    return { recorded: !error };
  } catch (err) {
    return { recorded: false, error: err };
  }
}

/** Load a folder item the caller owns, or null. */
async function ownedItem(supabase, ownerId, itemId) {
  const { data, error } = await supabase
    .from('folder_items')
    .select('id, title, status')
    .eq('id', itemId)
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Trash (soft, reversible) a folder item. NO-DELETE: the blob is retained. */
export async function trashItem(supabase, ownerId, itemId) {
  const item = await ownedItem(supabase, ownerId, itemId);
  if (!item) return { ok: false, reason: 'not_found' };
  const { error } = await supabase
    .from('folder_items').update({ status: 'trashed' })
    .eq('id', itemId).eq('owner_id', ownerId);
  if (error) throw error;
  await recordUndo(supabase, {
    ownerId, op: 'folder_trash', targetTable: 'folder_items', targetId: itemId,
    before: { status: item.status }, after: { status: 'trashed' },
  });
  return { ok: true };
}

/** Restore a trashed folder item. */
export async function restoreItem(supabase, ownerId, itemId) {
  const item = await ownedItem(supabase, ownerId, itemId);
  if (!item) return { ok: false, reason: 'not_found' };
  const { error } = await supabase
    .from('folder_items').update({ status: 'active' })
    .eq('id', itemId).eq('owner_id', ownerId);
  if (error) throw error;
  await recordUndo(supabase, {
    ownerId, op: 'folder_restore', targetTable: 'folder_items', targetId: itemId,
    before: { status: item.status }, after: { status: 'active' },
  });
  return { ok: true };
}

/** Rename a folder item. */
export async function renameItem(supabase, ownerId, itemId, title) {
  const item = await ownedItem(supabase, ownerId, itemId);
  if (!item) return { ok: false, reason: 'not_found' };
  const { error } = await supabase
    .from('folder_items').update({ title }).eq('id', itemId).eq('owner_id', ownerId);
  if (error) throw error;
  await recordUndo(supabase, {
    ownerId, op: 'folder_rename', targetTable: 'folder_items', targetId: itemId,
    before: { title: item.title }, after: { title },
  });
  return { ok: true };
}

/** Create a stone (named collection). */
export async function createStone(supabase, ownerId, { name }) {
  const { data, error } = await supabase
    .from('stone_collections')
    .insert({ owner_id: ownerId, name: name ?? 'Untitled stone' })
    .select('id, name, position, created_at')
    .single();
  if (error) {
    if (isMissingTable(error)) return { stone: null, missingSchema: true };
    throw error;
  }
  await recordUndo(supabase, {
    ownerId, op: 'stone_create', targetTable: 'stone_collections', targetId: data.id,
    before: null, after: { name: data.name },
  });
  return { stone: data, missingSchema: false };
}

/** Rename a stone. */
export async function renameStone(supabase, ownerId, stoneId, name) {
  const { data: prev, error: readErr } = await supabase
    .from('stone_collections').select('id, name').eq('id', stoneId).eq('owner_id', ownerId).maybeSingle();
  if (readErr) throw readErr;
  if (!prev) return { ok: false, reason: 'not_found' };
  const { error } = await supabase
    .from('stone_collections').update({ name }).eq('id', stoneId).eq('owner_id', ownerId);
  if (error) throw error;
  await recordUndo(supabase, {
    ownerId, op: 'stone_rename', targetTable: 'stone_collections', targetId: stoneId,
    before: { name: prev.name }, after: { name },
  });
  return { ok: true };
}

/**
 * Copy a folder item INTO a stone (curate). The membership references the folder
 * item; the blob is NOT duplicated. addedBy = 'user' | 'roberta'. Idempotent on
 * (collection_id, folder_item_id).
 */
export async function copyToStone(supabase, ownerId, { collectionId, folderItemId, addedBy = 'user' }) {
  // Verify both ends belong to the caller (no cross-account stitching).
  const [{ data: stone }, item] = await Promise.all([
    supabase.from('stone_collections').select('id').eq('id', collectionId).eq('owner_id', ownerId).maybeSingle(),
    ownedItem(supabase, ownerId, folderItemId),
  ]);
  if (!stone) return { ok: false, reason: 'stone_not_found' };
  if (!item) return { ok: false, reason: 'item_not_found' };

  const { data, error } = await supabase
    .from('stone_collection_items')
    .upsert(
      { collection_id: collectionId, folder_item_id: folderItemId, owner_id: ownerId, added_by: addedBy },
      { onConflict: 'collection_id,folder_item_id', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: true, alreadyPresent: true };

  await recordUndo(supabase, {
    ownerId, op: 'copy_to_stone', targetTable: 'stone_collection_items', targetId: data.id,
    before: null, after: { collection_id: collectionId, folder_item_id: folderItemId, added_by: addedBy },
  });
  return { ok: true, membershipId: data.id };
}

/** Remove a folder item from a stone (membership only; the folder blob stays). */
export async function removeFromStone(supabase, ownerId, { collectionId, folderItemId }) {
  const { data: mem, error: readErr } = await supabase
    .from('stone_collection_items')
    .select('id, collection_id, folder_item_id, added_by')
    .eq('collection_id', collectionId).eq('folder_item_id', folderItemId).eq('owner_id', ownerId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!mem) return { ok: false, reason: 'not_found' };
  const { error } = await supabase
    .from('stone_collection_items').delete().eq('id', mem.id).eq('owner_id', ownerId);
  if (error) throw error;
  await recordUndo(supabase, {
    ownerId, op: 'remove_from_stone', targetTable: 'stone_collection_items', targetId: mem.id,
    before: { collection_id: mem.collection_id, folder_item_id: mem.folder_item_id, added_by: mem.added_by },
    after: null,
  });
  return { ok: true };
}

/**
 * UNDO the most recent not-yet-undone op for this account. Reverses by op type
 * using the before/after snapshot, then marks the log row undone_at. Returns the
 * op that was undone, or null when the stack is empty.
 */
export async function undoLast(supabase, ownerId) {
  const { data: entry, error } = await supabase
    .from('undo_log')
    .select('id, op, target_table, target_id, before, after')
    .eq('owner_id', ownerId)
    .is('undone_at', null)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return { undone: null, missingSchema: true };
    throw error;
  }
  if (!entry) return { undone: null, missingSchema: false };

  switch (entry.op) {
    case 'folder_trash':
    case 'folder_restore':
      await supabase.from('folder_items')
        .update({ status: entry.before?.status ?? 'active' })
        .eq('id', entry.target_id).eq('owner_id', ownerId);
      break;
    case 'folder_rename':
      await supabase.from('folder_items')
        .update({ title: entry.before?.title ?? null })
        .eq('id', entry.target_id).eq('owner_id', ownerId);
      break;
    case 'stone_rename':
      await supabase.from('stone_collections')
        .update({ name: entry.before?.name ?? 'Untitled stone' })
        .eq('id', entry.target_id).eq('owner_id', ownerId);
      break;
    case 'stone_create':
      // Reverse a just-created (empty/new) stone by removing it. No media is
      // lost — a stone is a collection, not a blob.
      await supabase.from('stone_collections')
        .delete().eq('id', entry.target_id).eq('owner_id', ownerId);
      break;
    case 'copy_to_stone':
      // Reverse an add by deleting the membership row.
      await supabase.from('stone_collection_items')
        .delete().eq('id', entry.target_id).eq('owner_id', ownerId);
      break;
    case 'remove_from_stone':
      // Reverse a removal by re-inserting the membership from the snapshot.
      if (entry.before) {
        await supabase.from('stone_collection_items').upsert(
          {
            collection_id: entry.before.collection_id,
            folder_item_id: entry.before.folder_item_id,
            owner_id: ownerId,
            added_by: entry.before.added_by ?? 'user',
          },
          { onConflict: 'collection_id,folder_item_id', ignoreDuplicates: true },
        );
      }
      break;
    case 'folder_reorder':
    case 'stone_reorder':
    case 'stone_item_reorder':
      // Generic positional reversal: `before` is [{id, position}, ...].
      if (Array.isArray(entry.before)) {
        const table = entry.target_table;
        for (const row of entry.before) {
          await supabase.from(table)
            .update({ position: row.position }).eq('id', row.id).eq('owner_id', ownerId);
        }
      }
      break;
    default:
      return { undone: null, missingSchema: false, reason: 'unknown_op' };
  }

  await supabase.from('undo_log')
    .update({ undone_at: new Date().toISOString() })
    .eq('id', entry.id).eq('owner_id', ownerId);

  return { undone: { op: entry.op, targetId: entry.target_id }, missingSchema: false };
}
