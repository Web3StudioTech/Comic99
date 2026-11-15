/**
 * Comic99 RSS Feed Builder
 * Reads news.json → writes feed.xml
 */

import { readFileSync, writeFileSync } from 'fs';

const news = JSON.parse(readFileSync('news.json', 'utf8'));
const items = (news.items || []).slice(0, 20);

function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Comic99 News</title>
    <link>https://web3studiotech.github.io/Comic99/news.html</link>
    <description>Auto-curated comic, manga and anime news by Comic99</description>
    <language>en</language>
    <lastBuildDate>${new Date(news.updated).toUTCString()}</lastBuildDate>
    <atom:link href="https://web3studiotech.github.io/Comic99/feed.xml" rel="self" type="application/rss+xml"/>
${items.map(item => `    <item>
      <title>${esc(item.headline)}</title>
      <link>${esc(item.url)}</link>
      <guid isPermaLink="true">${esc(item.url)}</guid>
      <description>${esc(item.summary)}</description>
      <category>${esc(item.category)}</category>
      <source url="${esc(item.url)}">${esc(item.source)}</source>
      <pubDate>${new Date(item.published).toUTCString()}</pubDate>
    </item>`).join('\n')}
  </channel>
</rss>`;

writeFileSync('feed.xml', xml);
console.log(`feed.xml written — ${items.length} items`);
