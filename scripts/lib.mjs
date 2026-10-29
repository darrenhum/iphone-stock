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
