// Scrape Reuters sitemaps → HTML → extract → chunk+embed → Qdrant
import 'dotenv/config';
import axios from 'axios';
import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { indexDocuments } from '../rag.js';

const UA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};
const clean = s => (s || '').replace(/\s+/g, ' ').trim();

function probablyArticle(u) {
  return /reuters\.com\/(world|business|markets|technology|legal|lifestyle)/i.test(u);
}

async function fetchReutersUrls(limit = 60) {
  const idx = 'https://www.reuters.com/arc/outboundfeeds/sitemap-index/?outputType=xml';
  const { data: xml } = await axios.get(idx, { timeout: 20000, headers: UA_HEADERS });
  const parser = new XMLParser();
  const root = parser.parse(xml);

  const sitemapEntries = Array.isArray(root?.sitemapindex?.sitemap)
    ? root.sitemapindex.sitemap
    : (root?.sitemapindex?.sitemap ? [root.sitemapindex.sitemap] : []);

  const urls = [];
  for (const smUrl of sitemapEntries.map(s => s.loc).filter(Boolean).slice(0, 6)) {
    try {
      const { data: smxml } = await axios.get(smUrl, { timeout: 20000, headers: UA_HEADERS });
      const smdoc = parser.parse(smxml);
      const urlNodes = Array.isArray(smdoc?.urlset?.url)
        ? smdoc.urlset.url
        : (smdoc?.urlset?.url ? [smdoc.urlset.url] : []);
      const locs = urlNodes.map(u => u.loc).filter(Boolean).filter(probablyArticle);
      for (const u of locs) {
        urls.push(u);
        if (urls.length >= limit) return urls;
      }
    } catch (e) {
      console.warn('sitemap fetch failed', smUrl, e.message);
    }
  }
  return urls.slice(0, limit);
}

async function fetchArticle(url) {
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers: UA_HEADERS,
      validateStatus: () => true,
    });
    if (res.status >= 400) {
      console.warn('skip', res.status, url);
      return null;
    }

    const html = res.data;
    const $ = load(html);

    let title = '';
    let text = '';

    // Prefer JSON-LD (most consistent)
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).contents().text();
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const it of items) {
          const t = it?.['@type'];
          if (t === 'NewsArticle' || (Array.isArray(t) && t.includes('NewsArticle'))) {
            if (it.headline && !title) title = it.headline;
            if (it.articleBody && !text) text = it.articleBody;
          }
        }
      } catch {}
    });

    // Fallback: paragraphs
    if (!text) {
      const paras = [];
      $('[data-testid*="paragraph"]').each((_, el) => paras.push($(el).text()));
      if (!paras.length) $('article p').each((_, el) => paras.push($(el).text()));
      if (!paras.length) $('p').each((_, el) => paras.push($(el).text()));
      text = clean(paras.join(' '));
    }
    if (!title) {
      title = clean($('meta[property="og:title"]').attr('content') || $('title').text());
    }

    text = clean(text);
    if (title && text && text.length > 200) {
      return { url, title, text, publishedAt: new Date().toISOString() };
    }
    console.warn('short/empty', url);
    return null;
  } catch (e) {
    console.warn('fetch fail', e.response?.status || e.code || e.message, url);
    return null;
  }
}

async function main() {
  const limit = parseInt(process.argv[2] || '80', 10);
  const topicFilter = process.argv[3]; // optional keyword filter on title/text

  console.log(`Fetching ~${limit} Reuters article URLs...`);
  const urls = await fetchReutersUrls(limit);
  console.log(`Got ${urls.length} URLs. Downloading & extracting...`);

  const docs = [];
  for (const u of urls) {
    const d = await fetchArticle(u);
    if (!d) continue;
    if (topicFilter) {
      const needle = topicFilter.toLowerCase();
      if (!d.title.toLowerCase().includes(needle) && !d.text.toLowerCase().includes(needle)) {
        continue;
      }
    }
    docs.push(d);
  }

  console.log(`Parsed ${docs.length} articles with usable text.`);
  if (!docs.length) {
    console.log('No articles parsed. Exiting.');
    return;
  }

  const { inserted } = await indexDocuments(docs);
  console.log(`Indexed ${inserted} chunks into "${process.env.QDRANT_COLLECTION || 'news_local'}".`);
}

main().catch(e => { console.error(e?.response?.data || e); process.exit(1); });
