/**
 * Comic99 Auto-News Fetcher
 * RSS feeds → Claude AI briefs → news.json
 *
 * Env vars (set in GitHub Actions workflow):
 *   ANTHROPIC_API_KEY   required
 *   NEWS_MAX_NEW        max new stories per run (default 20)
 *   NEWS_PER_FEED       max stories per feed (default 8)
 *   NEWS_KEEP           total items to keep in news.json (default 80)
 *   NEWS_MAX_AGE_HOURS  ignore stories older than this (default 72)
 *   NEWS_MAX_IMAGE_LOOKUPS  og:image fetches per run (default 15)
 *   NEWS_MODEL          Claude model to use (default claude-haiku-4-5)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import https from 'https';
import http from 'http';
import { XMLParser } from 'fast-xml-parser';

// ── Config ────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY      = process.env.ANTHROPIC_API_KEY;
const MAX_NEW            = parseInt(process.env.NEWS_MAX_NEW  || '20', 10);
const PER_FEED           = parseInt(process.env.NEWS_PER_FEED || '8',  10);
const KEEP               = parseInt(process.env.NEWS_KEEP     || '80', 10);
const MAX_AGE_HOURS      = parseInt(process.env.NEWS_MAX_AGE_HOURS || '72', 10);
const MAX_IMAGE_LOOKUPS  = parseInt(process.env.NEWS_MAX_IMAGE_LOOKUPS || '15', 10);
const MODEL              = process.env.NEWS_MODEL || 'claude-haiku-4-5';
const NEWS_JSON          = 'news.json';
const NEWS_JSON_TMP      = 'news.json.tmp';
const FEEDS_PATH         = 'scripts/feeds.json';

const CATEGORIES = ['Manga','Anime','Webtoon','Western','Cosplay','Events','Industry','Adaptation','Creator','Other'];

if (!ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function sha1(str) {
  return createHash('sha1').update(str).digest('hex').slice(0, 16);
}

function fetchUrl(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Comic99-NewsBot/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchRss(feedUrl) {
  try {
    const { body } = await fetchUrl(feedUrl, 12000);
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(body);
    const channel = parsed?.rss?.channel || parsed?.feed;
    if (!channel) return [];
    const items = channel.item || channel.entry || [];
    return (Array.isArray(items) ? items : [items]).map(item => ({
      title:     (item.title?.['#text'] || item.title || '').trim(),
      link:      item.link?.['@_href'] || item.link || item.guid?.['#text'] || item.guid || '',
      pubDate:   item.pubDate || item.published || item.updated || '',
      excerpt:   (item.description || item['content:encoded'] || item.summary || item.content?.['#text'] || '').replace(/<[^>]+>/g, '').trim().slice(0, 300),
      image:     item['media:content']?.['@_url'] || item.enclosure?.['@_url'] || item['media:thumbnail']?.['@_url'] || '',
    }));
  } catch (e) {
    console.warn(`  Feed error (${feedUrl.slice(0,60)}): ${e.message}`);
    return [];
  }
}

async function resolveGoogleNewsUrl(url) {
  if (!url.includes('news.google.com')) return url;
  try {
    const r = await fetchUrl(url, 8000);
    const match = r.body.match(/href="(https?:\/\/(?!news\.google\.com)[^"]+)"/);
    return match ? match[1] : url;
  } catch { return url; }
}

async function fetchOgImage(url) {
  try {
    const realUrl = await resolveGoogleNewsUrl(url);
    const { body } = await fetchUrl(realUrl, 8000);
    const match = body.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                || body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!match) return '';
    const img = match[1];
    if (/google\.com|gstatic\.com|googleusercontent\.com|ggpht\.com/.test(img)) return '';
    return img;
  } catch { return ''; }
}

async function callClaude(prompt) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  });
  const res = await fetchUrl('https://api.anthropic.com/v1/messages', 20000);
  // Using direct HTTPS POST
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          resolve(json?.content?.[0]?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.write(body);
    req.end();
  });
}

async function writeBrief(title, excerpt, sourceName) {
  const prompt = `You are a news editor for Comic99, a global comic, manga and cosplay platform. Write a brief for this story.

Source: ${sourceName}
Title: ${title}
Excerpt: ${excerpt || '(none)'}

Rules:
- Write in your own words. Never copy more than 4 consecutive words from the title or excerpt.
- Facts only from what is given. No invented numbers, quotes, or background.
- One to two sentences, maximum 45 words total.
- Neutral tone. No hype, no predictions.
- If the story is not about comics, manga, anime, webtoons, cosplay, ACG events, conventions, or the comic/manga/cosplay industry, reply with exactly: SKIP
- Cosplay stories: costume showcases, competition results, World Cosplay Summit, cosplay tutorials, notable cosplayers — these are ALWAYS relevant, never SKIP.
- Events stories: anime conventions, comic cons, ACG festivals, upcoming cons, Comiket, Anime Expo, Comic Fiesta — these are ALWAYS relevant, never SKIP.
- Reply with ONLY the brief text (or SKIP). No labels, no quotes, no explanation.

Category options: ${CATEGORIES.join(', ')}
- Use "Cosplay" for any cosplay showcase, competition, tutorial, or cosplayer spotlight.
- Use "Events" for any convention, festival, con schedule, event announcement, or upcoming event.
Also reply with the best category on a new line after the brief.

Format:
<brief text>
<category>`;

  try {
    const reply = await callClaude(prompt);
    const lines = reply.trim().split('\n').filter(l => l.trim());
    if (!lines.length || lines[0].trim() === 'SKIP') return null;
    const summary = lines[0].trim();
    const category = CATEGORIES.includes(lines[lines.length - 1]?.trim())
      ? lines[lines.length - 1].trim() : 'Other';
    return { summary, category };
  } catch (e) {
    console.warn(`  Claude error: ${e.message}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load existing news.json
  let existing = { updated: '', skipped: [], items: [] };
  if (existsSync(NEWS_JSON)) {
    try { existing = JSON.parse(readFileSync(NEWS_JSON, 'utf8')); } catch {}
  }
  const existingIds  = new Set(existing.items.map(i => i.id));
  const skippedIds   = new Set(existing.skipped || []);
  const existingTitles = new Set(existing.items.map(i => i.sourceTitle?.toLowerCase().slice(0, 60)));

  // Load feeds
  const feeds = JSON.parse(readFileSync(FEEDS_PATH, 'utf8'));
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600 * 1000;

  // Collect candidates
  const candidates = [];
  for (const feed of feeds) {
    console.log(`Fetching: ${feed.name}`);
    const items = await fetchRss(feed.url);
    let count = 0;
    for (const item of items) {
      if (!item.title || !item.link) continue;
      if (count >= PER_FEED) break;
      const id = sha1(item.link);
      if (existingIds.has(id) || skippedIds.has(id)) continue;
      const pub = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
      if (!isNaN(pub) && pub < cutoff) continue;
      const titleKey = item.title.toLowerCase().slice(0, 60);
      if (existingTitles.has(titleKey)) continue;
      candidates.push({ ...item, id, feedName: feed.name, pub });
      count++;
    }
  }

  // Sort by newest first, cap at MAX_NEW
  candidates.sort((a, b) => b.pub - a.pub);
  const toProcess = candidates.slice(0, MAX_NEW);
  console.log(`\nCandidates: ${candidates.length}, processing: ${toProcess.length}`);

  // Process each candidate
  const newItems = [];
  let imageLookups = 0;
  const newSkipped = [];

  for (const item of toProcess) {
    console.log(`  Brief: ${item.title.slice(0, 70)}`);
    const brief = await writeBrief(item.title, item.excerpt, item.feedName);
    if (!brief) {
      console.log(`    → SKIPPED`);
      newSkipped.push(item.id);
      continue;
    }

    // Get image
    let image = item.image || '';
    if (!image && imageLookups < MAX_IMAGE_LOOKUPS) {
      image = await fetchOgImage(item.link);
      imageLookups++;
    }
    if (image && /google\.com|gstatic\.com|googleusercontent\.com|ggpht\.com/.test(image)) {
      image = '';
    }

    newItems.push({
      id:          item.id,
      headline:    item.title.slice(0, 120),
      summary:     brief.summary,
      category:    brief.category,
      source:      item.feedName,
      url:         item.link,
      published:   new Date(item.pub).toISOString(),
      image:       image,
      sourceTitle: item.title,
    });
    console.log(`    → ${brief.category}: ${brief.summary.slice(0, 60)}...`);
  }

  // Merge + trim
  const merged = [...newItems, ...existing.items].slice(0, KEEP);
  const allSkipped = [...new Set([...newSkipped, ...(existing.skipped || [])])].slice(0, 500);

  const output = {
    updated: new Date().toISOString(),
    skipped: allSkipped,
    items:   merged,
  };

  // Write atomically
  writeFileSync(NEWS_JSON_TMP, JSON.stringify(output, null, 2));
  writeFileSync(NEWS_JSON, JSON.stringify(output, null, 2));
  try { import('fs').then(fs => fs.unlinkSync(NEWS_JSON_TMP)); } catch {}

  console.log(`\nDone. New: ${newItems.length}, skipped: ${newSkipped.length}, total: ${merged.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
