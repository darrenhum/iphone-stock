import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedUrl, isAvailable, parseFeed, diffSnapshot, updateRestocks, restockStats } from '../scripts/lib.mjs';

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

test('updateRestocks logs each restock with start, end and duration', () => {
  const meta = { 'MK244VC/A': { name: 'iPhone Duo 256GB Star White' } };
  const up = (part, available, storeNumber = 'R490') => [{ storeNumber, part, available }];
  let log = updateRestocks([], up('MK244VC/A', true), 'R490', '2026-01-01T10:00:00Z', meta);
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], { part: 'MK244VC/A', name: 'iPhone Duo 256GB Star White', storeNumber: 'R490', start: '2026-01-01T10:00:00Z', end: null, durationSec: null });

  log = updateRestocks(log, up('MK244VC/A', true), 'R490', '2026-01-01T10:01:00Z', meta);
  assert.equal(log.length, 1, 'no duplicate while already open');

  log = updateRestocks(log, up('MK244VC/A', false), 'R490', '2026-01-01T10:05:30Z', meta);
  assert.equal(log[0].end, '2026-01-01T10:05:30Z');
  assert.equal(log[0].durationSec, 330);

  log = updateRestocks(log, up('MK244VC/A', true, 'R399'), 'R490', '2026-01-01T11:00:00Z', meta);
  assert.equal(log.length, 1, 'other stores ignored');

  log = updateRestocks(log, up('MK244VC/A', true), 'R490', '2026-01-02T09:00:00Z', meta);
  assert.equal(log.length, 2);
  assert.equal(log[0].start, '2026-01-02T09:00:00Z', 'newest first');

  assert.deepEqual(restockStats(log, 'MK244VC/A'), { restockCount: 2, lastRestockAt: '2026-01-02T09:00:00Z', avgDurationSec: 330 });
  assert.deepEqual(restockStats(log, 'MK254VC/A'), { restockCount: 0, lastRestockAt: null, avgDurationSec: null });
});
