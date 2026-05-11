import fs from 'fs';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pMap from 'p-map';
import Parser from 'rss-parser';
import { parse } from 'json2csv';
import xml2js from 'xml2js';
import { MongoClient } from 'mongodb';

const rssParser = new Parser();

/* ============================
   CONFIG
============================ */

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const {
  HOST,
  PORTEND_EMAIL,
  PORTEND_PASSWORD,
  MONGO_URI,
  CompaniesToProcess = 'UsedInChecks',  // default only for this
  CONCURRENCY,
  DB_NAME,
  COLLECTION_NAME,
  MAX_SITEMAP_URLS,
  SITEMAP_CONCURRENCY,
} = config;

/*
CompaniesToProcess options:

"100"          → Process first 100 companies
"500"          → Process first 500 companies
"UsedInChecks" → (DEFAULT) Only companies used in checks
"All"          → Process all companies (paginated)
*/

function getCompanyFetchConfig(option) {
  const opt = String(option).toLowerCase();

  switch (opt) {
    case '100':
      return { limit: 100, usedInCheck: undefined, fetchAll: false };

    case '500':
      return { limit: 500, usedInCheck: undefined, fetchAll: false };

    case 'usedinchecks':
    case 'usedincheck':
      return { limit: 500, usedInCheck: true, fetchAll: true };

    case 'all':
    default:
      return { limit: 500, usedInCheck: undefined, fetchAll: true };
  }
}

const BATCH_SIZE = 100;
let isProcessing = false;

const COMMON_RSS_PATHS = [
  '/feed',
  '/rss',
  '/rss.xml',
  '/feed.xml',
  '/atom.xml',
  '/blog/rss',
  '/blog/feed',
  '/blog/rss.xml',
  '/news/rss',
  '/news/feed',
  '/news/rss.xml',
  '/resources/rss.xml',
];

/* ============================
   HELPERS
============================ */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function logProgress(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function normalizeUrl(url) {
  if (!url) return '';
  if (!url.startsWith('http')) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

function normalizeFeedUrl(url) {
  if (!url) return '';
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/^http:\/\//i, 'https://')
    .replace('://www.', '://');
}

/* ============================
   PICK BEST FEED
============================ */

function chooseBestFeed(feeds) {
  if (!feeds?.length) return feeds;

  const grouped = {};
  feeds.map(normalizeFeedUrl).forEach(f => {
    try {
      const d = new URL(f).hostname;
      grouped[d] ??= [];
      grouped[d].push(f);
    } catch {}
  });

  const result = [];

  for (const domain in grouped) {
    const list = grouped[domain];
    result.push(
      list.find(x => x.includes('/blog/')) ||
      list.find(x => x.includes('/news/')) ||
      list.find(x => /\/(feed|rss)(\.xml)?$/.test(x)) ||
      list[0]
    );
  }

  return [...new Set(result)];
}

/* ============================
   CSV (SAFE WRITE QUEUE)
============================ */

// let csvWriteQueue = Promise.resolve();

// async function safeSaveToCSV(data, file) {
//   csvWriteQueue = csvWriteQueue.then(() => {
//     const exists = fs.existsSync(file);
//     const csv = parse(data, { header: !exists });
//     fs.appendFileSync(file, csv + '\n');
//   });

//   return csvWriteQueue;
// }

/* ============================
   MONGODB
============================ */

let mongoClient;
let companyBlogsCollection;

async function connectMongo() {
  mongoClient = new MongoClient(MONGO_URI, { maxPoolSize: 10 });
  await mongoClient.connect();

  const db = mongoClient.db(DB_NAME);
  companyBlogsCollection = db.collection(COLLECTION_NAME);

  await companyBlogsCollection.createIndex(
    { companyId: 1, rss_feed_url: 1 },
    { unique: true }
  );

  logProgress('✅ MongoDB connected');
}

async function saveToMongo(doc) {
  try {
    await companyBlogsCollection.updateOne(
      {
        companyId: doc.companyId,
        rss_feed_url: doc.rss_feed_url,
      },
      { $setOnInsert: doc },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) {
      console.error('Mongo error:', err.message);
    }
  }
}

/* ============================
   AUTH & API
============================ */

async function loginToPortend() {
  try {
    const res = await axios.post(`${HOST}/nexus/v1/login`, {
      email: PORTEND_EMAIL,
      password: PORTEND_PASSWORD,
    });
    return res.data?.data?.sessionId || null;
  } catch (err) {
    logProgress(`❌ Login error: ${err.message}`);
    return null;
  }
}

async function getCompanies(sessionId, skip, fetchConfig) {
  const { limit, usedInCheck } = fetchConfig;

  try {
    const res = await axios.get(`${HOST}/nexus/v1/companies`, {
      params: {
        limit,
        skip,
        ...(usedInCheck !== undefined && { usedInCheck }),
      },
      headers: { sessionId },
      timeout: 15000,
    });

    return res.data?.data?.list || [];
  } catch {
    await sleep(3000);
    return [];
  }
}

/*
Publication check intentionally disabled.
Can be re-enabled later if needed.
*/

/* ============================
   RSS VALIDATION
============================ */

async function isThisAValidRSSFeed(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'RSS-Finder-Bot' },
    });

    const text = res.data;
    if (!text.includes('<rss') && !text.includes('<feed')) return false;

    const parsed = await rssParser.parseString(text);
    return parsed?.items?.length > 0;
  } catch {
    return false;
  }
}

/* ============================
   SITEMAP SUPPORT
============================ */

async function fetchSitemapUrls(baseUrl) {
  try {
    const res = await axios.get(`${baseUrl}/sitemap.xml`, { timeout: 10000 });
    const parsed = await xml2js.parseStringPromise(res.data);
    const urls =
      parsed?.urlset?.url?.map(u => u.loc?.[0]).filter(Boolean) || [];
    return urls.slice(0, MAX_SITEMAP_URLS);
  } catch {
    return [];
  }
}

function filterContentUrls(urls) {
  return urls.filter(u =>
    /blog|news|post|article|resource|press|insight/i.test(u)
  );
}

async function findRssFromPage(pageUrl) {
  try {
    const res = await axios.get(pageUrl, { timeout: 8000 });
    const $ = cheerio.load(res.data);
    const feeds = [];

    $('link[type="application/rss+xml"], link[type="application/atom+xml"]').each(
      (_, el) => {
        let href = $(el).attr('href');
        if (href?.startsWith('/')) {
          href = new URL(pageUrl).origin + href;
        }
        if (href) feeds.push(href);
      }
    );

    return feeds;
  } catch {
    return [];
  }
}

/* ============================
   FIND RSS FEEDS
============================ */

async function findRssFeeds(domainOrName) {
  const base = normalizeUrl(domainOrName);
  const found = [];

  for (const p of COMMON_RSS_PATHS) {
    const test = base + p;
    if (await isThisAValidRSSFeed(test)) found.push(test);
  }

  try {
    const res = await axios.get(base, { timeout: 8000 });
    const $ = cheerio.load(res.data);
    $('link[type="application/rss+xml"], link[type="application/atom+xml"]').each(
      (_, el) => {
        let href = $(el).attr('href');
        if (href?.startsWith('/')) href = base + href;
        if (href) found.push(href);
      }
    );
  } catch {}

  const valid = [];
  for (const f of [...new Set(found.map(normalizeFeedUrl))]) {
    if (await isThisAValidRSSFeed(f)) valid.push(f);
  }

  if (valid.length) return chooseBestFeed(valid);

  const sitemapUrls = filterContentUrls(await fetchSitemapUrls(base));
  const pageFeeds = await pMap(
    sitemapUrls,
    url => findRssFromPage(url),
    { concurrency: SITEMAP_CONCURRENCY }
  );

  const sitemapValid = [];
  for (const f of [...new Set(pageFeeds.flat().map(normalizeFeedUrl))]) {
    if (await isThisAValidRSSFeed(f)) sitemapValid.push(f);
  }

  return sitemapValid.length ? chooseBestFeed(sitemapValid) : [];
}

/* ============================
   MAIN
============================ */
async function main() {
  if (isProcessing) {
    logProgress('⚠️ Previous run still in progress. Skipping.');
    return;
  }

  isProcessing = true;

  let totalProcessed = 0;
  let batchNumber = 0;

  try {
    await connectMongo();

    const sessionId = await loginToPortend();
    if (!sessionId) throw new Error('Login failed');

    logProgress(`⚙️ CompaniesToProcess: ${CompaniesToProcess}`);
    logProgress('✅ Logged in');

    // const outputCSV = `rss_output_${CompaniesToProcess}.csv`;
    // if (fs.existsSync(outputCSV)) fs.unlinkSync(outputCSV);

    /* -------------------------------
       FETCH ALL COMPANIES
    -------------------------------- */

    const companies = [];
    let skip = 0;
    const fetchConfig = getCompanyFetchConfig(CompaniesToProcess);

    while (true) {
      const list = await getCompanies(sessionId, skip, fetchConfig);
      if (!list.length) break;

      companies.push(
        ...list.map(c => ({
          companyId: c.id,
          name: c.name || '',
          domain: c.domain || c.website || '',
        }))
      );

      skip += list.length;
      logProgress(`📦 Fetching companies: ${companies.length}`);

      if (!fetchConfig.fetchAll) break;
    }

    logProgress(`✔ Total companies fetched: ${companies.length}`);

    /* -------------------------------
       PROCESS IN BATCHES OF 100
    -------------------------------- */

    for (let i = 0; i < companies.length; i += BATCH_SIZE) {
      batchNumber++;

      const batch = companies.slice(i, i + BATCH_SIZE);
      let batchProcessed = 0;

      logProgress(
        `🚀 Processing batch ${batchNumber} (${batch.length} companies)`
      );

      await pMap(
        batch,
        async (c, idx) => {
          try {
            const index = i + idx + 1;
            logProgress(`🔎 ${index}/${companies.length}: ${c.domain || c.name}`);

            if (!c.domain) return;
            const feeds = await findRssFeeds(c.domain);

            const now = new Date().toISOString();

            const docs = feeds.map(feed => ({
              companyId: c.companyId,
              companyDomain: c.domain,
              rss_feed_url: feed,
              ts: now,
            }));
            
            if (docs.length) {
              // await safeSaveToCSV(docs, outputCSV);
              for (const doc of docs) {
                await saveToMongo(doc);
              }
            }
            
            if (docs.length) {
              batchProcessed++;
              totalProcessed++;
            }

          } catch (err) {
            logProgress(`❌ Error: ${err.message}`);
          }
        },
        { concurrency: CONCURRENCY }
      );

      /* -------------------------------
         LOG AFTER EACH BATCH
      -------------------------------- */

      await mongoClient.db('datasets').collection('log').insertOne({
        type: 'company_publication_finder',
        batchNumber,
        batchProcessed,
        totalProcessed,
        scope: CompaniesToProcess,
        ts: new Date().toISOString(),
      });

      logProgress(
        `📦 Batch ${batchNumber} done: ${batchProcessed} (total ${totalProcessed})`
      );

      /* -------------------------------
         PAUSE (EXCEPT LAST BATCH)
      -------------------------------- */

      if (i + BATCH_SIZE < companies.length) {
        const pauseMs =
          2 * 60 * 1000 + Math.floor(Math.random() * 60 * 1000);

        logProgress(`⏸️ Pausing for ${Math.round(pauseMs / 1000)} seconds`);
        await sleep(pauseMs);
      }
    }

    logProgress('🎉 All companies processed successfully');

  } catch (err) {
    logProgress(`❌ Fatal error: ${err.stack || err}`);
  } finally {
    isProcessing = false;
    if (mongoClient) await mongoClient.close();
  }
}

main().catch(console.error);

setInterval(() => {
  logProgress('⏰ Scheduled run started');
  main().catch(err =>
    logProgress(`❌ Scheduled run failed: ${err.stack || err}`)
  );
}, 24 * 60 * 60 * 1000);


