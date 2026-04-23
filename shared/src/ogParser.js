import * as cheerio from 'cheerio';

/**
 * Resolve a possibly-relative URL against a base. Returns null if unresolvable.
 */
function toAbsolute(value, baseUrl) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Read the first non-empty content attribute from a list of meta selectors.
 */
function pickMeta($, selectors) {
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length === 0) continue;
    const raw = el.attr('content');
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

/**
 * Extract OG / Twitter / standard meta tags from an HTML string.
 *
 * Priority (first hit wins):
 *   title       : og:title -> twitter:title -> <title>
 *   description : og:description -> twitter:description -> meta[name=description]
 *   image       : og:image -> og:image:url -> twitter:image -> twitter:image:src
 *   site_name   : og:site_name -> twitter:site -> URL hostname
 *   favicon     : link[rel=icon] | link[rel="shortcut icon"] | link[rel="apple-touch-icon"]
 *                 -> fallback to /favicon.ico
 *
 * All URLs are resolved to absolute using the page's final URL.
 * Returns a structured object plus `og_raw` containing every og:* / twitter:* tag encountered.
 */
export function parseOg(html, pageUrl) {
  const $ = cheerio.load(html ?? '');

  const og_raw = {};
  $('meta').each((_, el) => {
    const property = ($(el).attr('property') || $(el).attr('name') || '').trim().toLowerCase();
    const content = $(el).attr('content');
    if (!property || typeof content !== 'string') return;
    if (property.startsWith('og:') || property.startsWith('twitter:')) {
      og_raw[property] = content.trim();
    }
  });

  const title =
    pickMeta($, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    ($('title').first().text()?.trim() || null);

  const description = pickMeta($, [
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
  ]);

  const rawImage = pickMeta($, [
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
  ]);
  const hero_image_url = toAbsolute(rawImage, pageUrl);

  let site_name = pickMeta($, [
    'meta[property="og:site_name"]',
    'meta[name="application-name"]',
  ]);
  if (!site_name) {
    try {
      site_name = new URL(pageUrl).hostname.replace(/^www\./, '');
    } catch {
      site_name = null;
    }
  }

  // Favicon: prefer the richest declared icon; fall back to /favicon.ico.
  const iconCandidates = [
    'link[rel="icon"]',
    'link[rel="shortcut icon"]',
    'link[rel="apple-touch-icon"]',
    'link[rel="apple-touch-icon-precomposed"]',
  ];
  let rawIcon = null;
  for (const sel of iconCandidates) {
    const el = $(sel).first();
    if (el.length && el.attr('href')) {
      rawIcon = el.attr('href');
      break;
    }
  }
  const favicon_url =
    toAbsolute(rawIcon, pageUrl) || toAbsolute('/favicon.ico', pageUrl);

  return {
    title,
    description,
    hero_image_url,
    site_name,
    favicon_url,
    og_raw,
  };
}
