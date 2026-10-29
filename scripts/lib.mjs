// Pure helpers for Apple's retail pickup feed (the endpoint instockradar-style
// trackers use): https://www.apple.com/<cc>/shop/retail/pickup-message

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

export function buildFeedUrl(config) {
  const params = new URLSearchParams({ pl: 'true', location: config.location });
  Object.keys(config.parts).forEach((part, i) => params.set(`parts.${i}`, part));
  const cc = config.country && config.country !== 'us' ? `/${config.country}` : '';
  return `https://www.apple.com${cc}/shop/retail/pickup-message?${params}`;
}

export function isAvailable(info) {
  if (!info) return false;
  const regular = info.messageTypes?.regular ?? {};
  if (regular.storeSelectionEnabled === true) return true;
  const display = String(info.pickupDisplay ?? '').trim().toLowerCase();
  if (display === 'available') return true;
  const quote = String(info.pickupSearchQuote ?? '').trim().toLowerCase();
  return quote.startsWith('available');
}

// Returns { stores: [{ storeNumber, name, city, distance, parts: { [part]: { available, quote } } }] }
export function parseFeed(json, config) {
  const stores = json?.body?.stores;
  if (!Array.isArray(stores)) throw new Error('Unexpected feed shape: body.stores missing');
  return {
    stores: stores.map((s) => {
      const parts = {};
      for (const part of Object.keys(config.parts)) {
        const info = s.partsAvailability?.[part];
        if (!info) continue;
        parts[part] = {
          available: isAvailable(info),
          quote: info.messageTypes?.regular?.storePickupQuote || info.pickupSearchQuote || info.pickupDisplay || '',
        };
      }
      return {
        storeNumber: String(s.storeNumber ?? ''),
        name: String(s.storeName ?? s.storeNumber ?? ''),
        city: [s.city, s.state].filter(Boolean).join(', '),
        distance: s.storeDistanceWithUnit ?? '',
        parts,
      };
    }),
  };
}

// Appends/closes restock records for one store based on diff changes.
// A record is { part, name, storeNumber, start, end, durationSec } with end=null while still in stock.
// Returns a new array (newest first).
export function updateRestocks(restocks, changes, storeNumber, nowIso, partsMeta = {}) {
  const list = [...(restocks ?? [])];
  for (const c of changes) {
    if (c.storeNumber !== storeNumber) continue;
    const open = list.find((r) => r.part === c.part && r.storeNumber === storeNumber && !r.end);
    if (c.available && !open) {
      list.unshift({ part: c.part, name: partsMeta[c.part]?.name ?? c.part, storeNumber, start: nowIso, end: null, durationSec: null });
    } else if (!c.available && open) {
      open.end = nowIso;
      open.durationSec = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(open.start)) / 1000));
    }
  }
  return list;
}

export function restockStats(restocks, part) {
  const mine = restocks.filter((r) => r.part === part);
  const closed = mine.filter((r) => r.durationSec != null);
  return {
    restockCount: mine.length,
    lastRestockAt: mine[0]?.start ?? null,
    avgDurationSec: closed.length ? Math.round(closed.reduce((a, r) => a + r.durationSec, 0) / closed.length) : null,
  };
}

// Compares a parsed snapshot to previous availability state.
// prev: { "<store>|<part>": { available, since } }
// Returns { next, changes: [{ key, storeNumber, storeName, part, available, quote }] }
export function diffSnapshot(prev, snapshot, nowIso) {
  const next = {};
  const changes = [];
  for (const store of snapshot.stores) {
    for (const [part, p] of Object.entries(store.parts)) {
      const key = `${store.storeNumber}|${part}`;
      const before = prev?.[key];
      const changed = !before || before.available !== p.available;
      next[key] = { available: p.available, since: changed ? nowIso : before.since };
      if (changed && (before || p.available)) {
        changes.push({ key, storeNumber: store.storeNumber, storeName: store.name, part, available: p.available, quote: p.quote });
      }
    }
  }
  return { next, changes };
}
