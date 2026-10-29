#!/usr/bin/env node
// Polls Apple's pickup feed, diffs against saved state, sends Web Push (and
// optional ntfy) alerts, and writes the status.json consumed by the PWA.
//
// Env:
//   POLL_DURATION_SECONDS  keep checking for this long (default 0 = single check)
//   POLL_INTERVAL_SECONDS  seconds between check starts (default 20, min 10)
//   STATE_FILE             persisted state (default .state/state.json)
//   OUT_DIR                where status.json is written (default _site)
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
//   PUSH_SUBSCRIPTIONS     optional JSON (array or single) of push subscriptions
//   NTFY_TOPIC / NTFY_SERVER  optional backup alerts via ntfy
//   SITE_URL               URL opened when a notification is tapped
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { USER_AGENT, buildFeedUrl, parseFeed, diffSnapshot, updateRestocks, restockStats } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const env = process.env;
const DURATION_MS = Math.max(0, parseFloat(env.POLL_DURATION_SECONDS || '0')) * 1000;
const INTERVAL_MS = Math.max(10, parseFloat(env.POLL_INTERVAL_SECONDS || '20')) * 1000;
const JITTER_MS = 2000;
const STATE_FILE = path.resolve(ROOT, env.STATE_FILE || '.state/state.json');
const OUT_DIR = path.resolve(ROOT, env.OUT_DIR || '_site');
const MAX_EVENTS = 50;
const MAX_RESTOCKS = 5000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadSubscriptions() {
  const subs = [];
  const dir = path.join(ROOT, 'subscriptions');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const s = readJson(path.join(dir, f), null);
      if (s?.endpoint) subs.push(s);
      else log(`Skipping invalid subscription file ${f}`);
    }
  }
  if (env.PUSH_SUBSCRIPTIONS?.trim()) {
    try {
      const parsed = JSON.parse(env.PUSH_SUBSCRIPTIONS);
      for (const s of [].concat(parsed)) if (s?.endpoint) subs.push(s);
    } catch (e) {
      log('PUSH_SUBSCRIPTIONS is not valid JSON:', e.message);
    }
  }
  const seen = new Set();
  return subs.filter((s) => !seen.has(s.endpoint) && seen.add(s.endpoint));
}

async function notify({ title, body, tag, url }) {
  log(`ALERT: ${title} — ${body}`);
  const results = { push: 0, pushFailed: 0, ntfy: false };

  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(env.VAPID_SUBJECT || env.SITE_URL || 'mailto:alerts@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    const payload = JSON.stringify({ title, body, tag, url: url || env.SITE_URL || config.productUrl });
    for (const sub of loadSubscriptions()) {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high', topic: tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) });
        results.push++;
      } catch (e) {
        results.pushFailed++;
        const gone = e.statusCode === 404 || e.statusCode === 410;
        log(`Push failed (${e.statusCode ?? e.message})${gone ? ' — subscription expired; remove it from subscriptions/' : ''}: ${sub.endpoint.slice(0, 60)}…`);
      }
    }
  } else {
    log('VAPID keys not configured; skipping Web Push (run `npm run setup-push`).');
  }

  if (env.NTFY_TOPIC) {
    try {
      const res = await fetch(`${(env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(env.NTFY_TOPIC)}`, {
        method: 'POST',
        body,
        headers: { Title: title, Tags: 'iphone', Priority: 'high', Click: url || config.productUrl },
      });
      results.ntfy = res.ok;
    } catch (e) {
      log('ntfy failed:', e.message);
    }
  }
  return results;
}

async function fetchFeed() {
  const res = await fetch(buildFeedUrl(config), {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const err = new Error(`Apple feed returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return parseFeed(await res.json(), config);
}

function buildStatus(state, snapshot) {
  const store = snapshot?.stores.find((s) => s.storeNumber === config.storeNumber);
  const parts = Object.entries(config.parts).map(([part, meta]) => {
    const p = store?.parts[part];
    const st = state.availability[`${config.storeNumber}|${part}`];
    return { part, ...meta, available: Boolean(p?.available), quote: p?.quote ?? 'No data', since: st?.since ?? null, ...restockStats(state.restocks, part) };
  });
  const nearby = (snapshot?.stores ?? [])
    .filter((s) => s.storeNumber !== config.storeNumber)
    .map((s) => ({
      storeNumber: s.storeNumber,
      name: s.name,
      city: s.city,
      distance: s.distance,
      available: Object.entries(s.parts).filter(([, p]) => p.available).map(([part]) => part),
    }));
  return {
    generatedAt: new Date().toISOString(),
    lastCheckAt: state.lastCheckAt ?? null,
    lastSuccessAt: state.lastSuccessAt ?? null,
    lastError: state.lastError ?? null,
    store: {
      number: config.storeNumber,
      name: store?.name ? `Apple ${store.name}` : config.storeName,
      city: config.storeCity,
      found: Boolean(store),
    },
    productName: config.productName,
    productUrl: config.productUrl,
    anyAvailable: parts.some((p) => p.available),
    parts,
    nearby,
    events: state.events.slice(0, MAX_EVENTS),
  };
}

// Restock log survives Actions cache eviction by re-seeding from the deployed site.
async function seedRestocks(state) {
  if (Array.isArray(state.restocks)) return;
  state.restocks = [];
  if (!env.SITE_URL) return;
  try {
    const res = await fetch(new URL(`history.json?t=${Date.now()}`, env.SITE_URL), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.restocks)) state.restocks = data.restocks;
    log(`Seeded ${state.restocks.length} restock records from ${env.SITE_URL}history.json`);
  } catch (e) {
    log(`No previous history.json to seed from (${e.message}).`);
  }
}

async function main() {
  const testPush = process.argv.includes('--test-push');
  const state = readJson(STATE_FILE, null) ?? {};
  state.availability ??= {};
  state.events ??= [];
  await seedRestocks(state);
  let snapshot = state.lastSnapshot ?? null;

  if (testPush) {
    const r = await notify({
      title: `${config.productName} tracker test`,
      body: `Notifications work! You'll be alerted when ${config.productName} stock appears at ${config.storeName}.`,
      tag: 'test',
    });
    log('Test push result:', r);
  }

  const deadline = Date.now() + DURATION_MS;
  for (let i = 0; ; i++) {
    const startedAt = Date.now();
    const now = new Date().toISOString();
    state.lastCheckAt = now;
    try {
      snapshot = await fetchFeed();
      const { next, changes } = diffSnapshot(state.availability, snapshot, now);
      state.availability = next;
      state.restocks = updateRestocks(state.restocks, changes, config.storeNumber, now, config.parts).slice(0, MAX_RESTOCKS);
      state.lastSuccessAt = now;
      state.lastError = null;
      state.lastSnapshot = snapshot;

      const bayshore = snapshot.stores.find((s) => s.storeNumber === config.storeNumber);
      const summary = bayshore
        ? Object.entries(bayshore.parts).map(([p, v]) => `${p}:${v.available ? 'YES' : 'no'}`).join(' ')
        : `store ${config.storeNumber} not in response`;
      log(`Check ${i + 1}: ${summary}`);

      for (const c of changes) {
        const meta = config.parts[c.part] ?? { name: c.part };
        state.events.unshift({ at: now, storeNumber: c.storeNumber, store: c.storeName, part: c.part, name: meta.name, available: c.available });
        if (c.available && config.alertStores.includes(c.storeNumber)) {
          await notify({
            title: `🟢 ${meta.name} in stock!`,
            body: `Available for pickup at Apple ${c.storeName}. ${c.quote}`.trim(),
            tag: c.part,
            url: config.productUrl,
          });
        }
      }
      state.events = state.events.slice(0, MAX_EVENTS);
    } catch (e) {
      state.lastError = { at: now, message: e.message, status: e.status ?? null };
      log(`Check ${i + 1} failed: ${e.message}`);
      if (e.status === 541 || e.status === 403) {
        log('Apple is rate-limiting this runner; stopping this run early.');
        break;
      }
    }

    // Fixed cadence measured start-to-start, with a little jitter.
    const wait = INTERVAL_MS - (Date.now() - startedAt) + Math.round((Math.random() * 2 - 1) * JITTER_MS);
    if (Date.now() + Math.max(wait, 0) >= deadline) break;
    await sleep(Math.max(wait, 1000));
  }

  writeJson(STATE_FILE, state);
  writeJson(path.join(OUT_DIR, 'status.json'), buildStatus(state, snapshot));
  writeJson(path.join(OUT_DIR, 'history.json'), {
    generatedAt: new Date().toISOString(),
    storeNumber: config.storeNumber,
    storeName: config.storeName,
    parts: config.parts,
    restocks: state.restocks,
  });
  log(`Wrote ${path.relative(ROOT, path.join(OUT_DIR, 'status.json'))}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
