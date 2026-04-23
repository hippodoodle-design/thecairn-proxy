import { request } from 'undici';
import { validateUrl } from '@cairn/shared/validateUrl';
import { parseOg } from '@cairn/shared/ogParser';
import { getServiceClient } from '@cairn/shared/supabase';

const MAX_BYTES = 5 * 1024 * 1024;    // 5 MB hard cap
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = 'CairnBot/1.0 (+https://thecairn.app)';

/**
 * Fetch with streaming body + byte cap. Rejects if Content-Length exceeds the cap
 * OR if the stream exceeds it mid-download, so a lying Content-Length can't sneak
 * through. Returns { html, status, bytes, durationMs }.
 */
async function fetchHtml(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const start = Date.now();

  try {
    const res = await request(url, {
      method: 'GET',
      maxRedirections: 5,
      signal: ac.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'accept-language': 'en',
      },
    });

    const status = res.statusCode;
    if (status < 200 || status >= 300) {
      res.body.resume();
      throw new Error(`Upstream responded ${status}`);
    }

    const contentType = String(res.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      res.body.resume();
      throw new Error(`Unsupported content-type: ${contentType || 'unknown'}`);
    }

    const declared = Number(res.headers['content-length']);
    if (!Number.isNaN(declared) && declared > MAX_BYTES) {
      res.body.resume();
      throw new Error('Response too large');
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        ac.abort();
        throw new Error('Response too large');
      }
      chunks.push(chunk);
    }

    const html = Buffer.concat(chunks).toString('utf8');
    return {
      html,
      status,
      bytes: total,
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Job processor for 'url-digest'.
 *
 * Input:  job.data = { kind: 'url', url, ownerId }
 * Output: { stoneId, title }
 *
 * Inserts one row into public.stones using the service-role client. The web layer
 * has already verified ownerId === the caller's JWT sub; the worker trusts that
 * assertion and writes bypassing RLS.
 */
export async function urlDigest(job, log) {
  const jobStart = Date.now();
  const { url, ownerId } = job.data || {};
  const jobLog = log.child({ jobId: job.id });

  if (!ownerId) throw new Error('ownerId missing from job payload');
  if (!url) throw new Error('url missing from job payload');

  // Re-validate at worker time — cheap, and protects against DNS-rebinding or
  // a stale job sitting in the queue after upstream IPs changed.
  const check = await validateUrl(url);
  if (!check.ok) throw new Error(`URL failed validation: ${check.error}`);

  const resolved = check.url.toString();
  const { html, status, bytes, durationMs: fetchMs } = await fetchHtml(resolved);

  jobLog.info({
    event: 'url_fetched',
    url: resolved,
    status,
    bytes,
    durationMs: fetchMs,
  });

  const meta = parseOg(html, resolved);

  const title =
    (meta.title && meta.title.slice(0, 500)) ||
    check.url.hostname.replace(/^www\./, '');

  const row = {
    owner_id: ownerId,
    kind: 'url',
    title,
    content_url: resolved,
    metadata: {
      description: meta.description,
      hero_image_url: meta.hero_image_url,
      site_name: meta.site_name,
      favicon_url: meta.favicon_url,
      og_raw: meta.og_raw,
    },
    is_favourite: false,
  };

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('stones')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    jobLog.error({ msg: 'supabase insert failed', err: error });
    throw new Error(`Supabase insert failed: ${error.message}`);
  }

  jobLog.info({
    event: 'stone_landed',
    title,
    siteName: meta.site_name || check.url.hostname.replace(/^www\./, ''),
    durationMs: Date.now() - jobStart,
    stoneId: data.id,
    ownerIdTail: ownerId.slice(-4),
  });

  return { stoneId: data.id, title };
}
