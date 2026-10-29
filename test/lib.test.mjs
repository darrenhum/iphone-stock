import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedUrl, isAvailable, parseFeed, diffSnapshot } from '../scripts/lib.mjs';

const config = {
  country: 'ca',
  location: 'K2B 8C1',
  parts: { 'MK244VC/A': {}, 'MK254VC/A': {} },
};

// Shape captured from https://www.apple.com/ca/shop/retail/pickup-message (trimmed).
const feed = (avail244) => ({
  head: { status: '200' },
  body: {
    stores: [
      {
        storeName: 'Bayshore Shopping Centre',
        storeNumber: 'R490',
        city: 'Ottawa',
        state: 'ON',
        storeDistanceWithUnit: '0.06 km',
        partsAvailability: {
          'MK244VC/A': {
            pickupSearchQuote: avail244 ? 'Available Today' : 'Currently unavailable',
            pickupDisplay: avail244 ? 'available' : 'unavailable',
            messageTypes: { regular: { storeSelectionEnabled: avail244, storePickupQuote: avail244 ? 'Today at Apple Bayshore' : 'Currently unavailable at Apple Bayshore Shopping Centre' } },
          },
          'MK254VC/A': {
            pickupSearchQuote: 'Currently unavailable',
            pickupDisplay: 'unavailable',
            messageTypes: { regular: { storeSelectionEnabled: false } },
          },
        },
      },
      { storeName: 'Rideau', storeNumber: 'R399', partsAvailability: {} },
    ],
  },
});

test('buildFeedUrl targets the Canadian pickup-message endpoint with all parts', () => {
  const url = new URL(buildFeedUrl(config));
  assert.equal(url.origin + url.pathname, 'https://www.apple.com/ca/shop/retail/pickup-message');
  assert.equal(url.searchParams.get('location'), 'K2B 8C1');
  assert.equal(url.searchParams.get('parts.0'), 'MK244VC/A');
  assert.equal(url.searchParams.get('parts.1'), 'MK254VC/A');
});

test('isAvailable', () => {
  assert.equal(isAvailable({ pickupDisplay: 'unavailable', messageTypes: { regular: { storeSelectionEnabled: false } } }), false);
  assert.equal(isAvailable({ pickupDisplay: 'available' }), true);
  assert.equal(isAvailable({ messageTypes: { regular: { storeSelectionEnabled: true } } }), true);
  assert.equal(isAvailable(undefined), false);
});

test('parseFeed extracts per-store availability', () => {
  const snap = parseFeed(feed(true), config);
  assert.equal(snap.stores[0].storeNumber, 'R490');
  assert.equal(snap.stores[0].city, 'Ottawa, ON');
  assert.equal(snap.stores[0].parts['MK244VC/A'].available, true);
  assert.equal(snap.stores[0].parts['MK254VC/A'].available, false);
  assert.deepEqual(snap.stores[1].parts, {});
  assert.throws(() => parseFeed({ body: {} }, config));
});

test('diffSnapshot reports only transitions (and initial in-stock)', () => {
  const t0 = '2026-01-01T00:00:00Z';
  const first = diffSnapshot({}, parseFeed(feed(false), config), t0);
  assert.equal(first.changes.length, 0, 'unavailable on first run is not an alert');

  const t1 = '2026-01-01T00:01:00Z';
  const second = diffSnapshot(first.next, parseFeed(feed(true), config), t1);
  assert.deepEqual(second.changes.map((c) => [c.part, c.available]), [['MK244VC/A', true]]);
  assert.equal(second.next['R490|MK244VC/A'].since, t1);
  assert.equal(second.next['R490|MK254VC/A'].since, t0);

  const third = diffSnapshot(second.next, parseFeed(feed(true), config), '2026-01-01T00:02:00Z');
  assert.equal(third.changes.length, 0, 'no repeat alert while still in stock');

  const fourth = diffSnapshot(third.next, parseFeed(feed(false), config), '2026-01-01T00:03:00Z');
  assert.deepEqual(fourth.changes.map((c) => [c.part, c.available]), [['MK244VC/A', false]]);

  const fresh = diffSnapshot({}, parseFeed(feed(true), config), t0);
  assert.equal(fresh.changes.length, 1, 'in stock on first run alerts');
});
