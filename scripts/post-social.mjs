/**
 * Comic99 Social Auto-Poster
 * Picks the best unposted story from news.json and posts to Facebook + Twitter/X
 *
 * Env vars (GitHub Secrets):
 *   FB_PAGE_ID        Facebook Page ID
 *   FB_PAGE_TOKEN     Facebook Page access token (long-lived, never expires)
 *   X_API_KEY         Twitter/X Consumer Key
 *   X_API_SECRET      Twitter/X Consumer Secret
 *   X_ACCESS_TOKEN    Twitter/X Access Token
 *   X_ACCESS_SECRET   Twitter/X Access Token Secret
 *   DRY_RUN           set to "true" to log without posting (default false)
 *
 * Optional:
 *   MAX_PER_DAY       max posts per platform per day (default 2)
 *   POSTED_JSON       path to track posted IDs (default posted.json)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import https from 'https';
import crypto from 'crypto';

const DRY_RUN     = process.env.DRY_RUN === 'true';
const MAX_PER_DAY = parseInt(process.env.MAX_PER_DAY || '2', 10);
const POSTED_JSON = process.env.POSTED_JSON || 'posted.json';

// ── Helpers ───────────────────────────────────────────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : (await import('http')).default;
    https.get(url, { headers: { 'User-Agent': 'Comic99-SocialBot/1.0' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

// ── Facebook ──────────────────────────────────────────────────────────────────
async function postFacebook(item, pageId, pageToken) {
  const text = `📰 ${item.headline}\n\n${item.summary}\n\n👉 Read more: ${item.url}\n\n#Comic99 #${item.category.replace(/\s/g,'')} #Manga #Anime #Comics`;

  if (DRY_RUN) {
    console.log('[DRY RUN] Facebook post:\n' + text);
    return true;
  }

  const params = new URLSearchParams({
    message: text,
    link: item.url,
    access_token: pageToken,
  });

  try {
    const res = await new Promise((resolve, reject) => {
      const body = params.toString();
      const req = https.request({
        hostname: 'graph.facebook.com',
        path: `/v19.0/${pageId}/feed`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    const json = JSON.parse(res.body);
    if (json.id) {
      console.log(`✅ Facebook posted: ${json.id}`);
      return true;
    } else {
      console.error('❌ Facebook error:', res.body.slice(0, 300));
      return false;
    }
  } catch (e) {
    console.error('❌ Facebook exception:', e.message);
    return false;
  }
}

// ── Twitter / X ───────────────────────────────────────────────────────────────
function oauthSign(method, url, params, consumerKey, consumerSecret, tokenKey, tokenSecret) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: tokenKey,
    oauth_version: '1.0',
  };

  const allParams = { ...params, ...oauthParams };
  const sortedParams = Object.keys(allParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const sigBase = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(sortedParams)].join('&');
  const sigKey  = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  const sig     = crypto.createHmac('sha1', sigKey).update(sigBase).digest('base64');

  oauthParams.oauth_signature = sig;
  const header = 'OAuth ' + Object.keys(oauthParams).sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return header;
}

async function postTwitter(item, apiKey, apiSecret, accessToken, accessSecret) {
  // Twitter text: ~240 chars, no link (to avoid credit charges for link posts)
  const tag = `#${item.category.replace(/\s/g,'')}`;
  let text = `📢 ${item.headline}\n\n${item.summary}\n\n${tag} #Comic99 #Manga #Anime`;
  if (text.length > 280) text = text.slice(0, 277) + '...';

  if (DRY_RUN) {
    console.log('[DRY RUN] Twitter post:\n' + text);
    return true;
  }

  const tweetUrl = 'https://api.twitter.com/2/tweets';
  const body = JSON.stringify({ text });
  const authHeader = oauthSign('POST', tweetUrl, {}, apiKey, apiSecret, accessToken, accessSecret);

  try {
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.twitter.com',
        path: '/2/tweets',
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        }
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    if (res.status === 402) {
      console.error('❌ Twitter error 402: credits depleted — top up at developer.x.com');
      return false;
    }
    const json = JSON.parse(res.body);
    if (json.data?.id) {
      console.log(`✅ Twitter posted: ${json.data.id}`);
      return true;
    } else {
      console.error('❌ Twitter error:', res.body.slice(0, 300));
      return false;
    }
  } catch (e) {
    console.error('❌ Twitter exception:', e.message);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load news.json
  if (!existsSync('news.json')) { console.error('news.json not found'); process.exit(1); }
  const news = JSON.parse(readFileSync('news.json', 'utf8'));

  // Load posted log
  let posted = { items: [] };
  if (existsSync(POSTED_JSON)) {
    try { posted = JSON.parse(readFileSync(POSTED_JSON, 'utf8')); } catch {}
  }
  const postedIds = new Set(posted.items.map(p => p.id));

  // Count today's posts
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayPosts = (posted.items || []).filter(p => p.date === todayStr);
  if (todayPosts.length >= MAX_PER_DAY) {
    console.log(`Daily cap reached (${MAX_PER_DAY} posts today). Skipping.`);
    return;
  }

  // Find best unposted story from last 24h
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const candidates = news.items.filter(item =>
    !postedIds.has(item.id) &&
    new Date(item.published).getTime() > cutoff
  );

  if (!candidates.length) {
    console.log('No new unposted stories in the last 24h.');
    return;
  }

  // Pick top story — prefer Adaptation/Events/Industry over Other
  const priority = ['Adaptation', 'Events', 'Manga', 'Anime', 'Webtoon', 'Industry', 'Creator', 'Cosplay', 'Western', 'Other'];
  candidates.sort((a, b) => priority.indexOf(a.category) - priority.indexOf(b.category));
  const item = candidates[0];

  console.log(`Selected: [${item.category}] ${item.headline}`);

  const results = { fb: false, tw: false };

  // Facebook
  const fbPageId    = process.env.FB_PAGE_ID;
  const fbPageToken = process.env.FB_PAGE_TOKEN;
  if (fbPageId && fbPageToken) {
    console.log('\nPosting to Facebook...');
    results.fb = await postFacebook(item, fbPageId, fbPageToken);
  } else {
    console.log('Facebook secrets not set — skipping.');
  }

  // Twitter / X
  const xApiKey      = process.env.X_API_KEY;
  const xApiSecret   = process.env.X_API_SECRET;
  const xAccessToken = process.env.X_ACCESS_TOKEN;
  const xAccessSecret= process.env.X_ACCESS_SECRET;
  if (xApiKey && xApiSecret && xAccessToken && xAccessSecret) {
    console.log('\nPosting to Twitter/X...');
    results.tw = await postTwitter(item, xApiKey, xApiSecret, xAccessToken, xAccessSecret);
  } else {
    console.log('Twitter/X secrets not set — skipping.');
  }

  // Update posted log
  if (results.fb || results.tw || DRY_RUN) {
    posted.items.unshift({ id: item.id, headline: item.headline, date: todayStr, fb: results.fb, tw: results.tw });
    posted.items = posted.items.slice(0, 200); // keep last 200
    writeFileSync(POSTED_JSON, JSON.stringify(posted, null, 2));
    console.log(`\nLogged to ${POSTED_JSON}`);
  }

  if (!results.fb && !results.tw && !DRY_RUN) {
    console.error('\nNo platforms posted successfully.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
