const $ = (id) => document.getElementById(id);
const POLL_MS = 30_000;
const STALE_MS = 20 * 60_000;
const SEEN_KEY = 'duo-stock:last-available';

let appConfig = {};
let swReg = null;
let timer = null;

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const slug = (s) => String(s).toLowerCase().replace(/\s+/g, '-');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function loadStatus() {
  $('refresh').classList.add('spin');
  try {
    const res = await fetch(`status.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    render(status);
    await maybeLocalNotify(status);
  } catch (e) {
    $('hero').className = 'hero stale';
    $('hero-title').textContent = 'Offline';
    $('hero-sub').textContent = `Couldn't load stock (${e.message}).`;
  } finally {
    $('refresh').classList.remove('spin');
  }
}

function render(status) {
  const parts = status.parts ?? [];
  const available = parts.filter((p) => p.available);
  const stale = !status.lastSuccessAt || Date.now() - new Date(status.lastSuccessAt).getTime() > STALE_MS;

  if (status.productName) $('title').textContent = status.productName;
  if (status.store?.name) $('store').textContent = `${status.store.name} · ${status.store.city ?? ''}`;
  if (status.productUrl) $('buy').href = status.productUrl;

  const hero = $('hero');
  if (!status.lastSuccessAt) {
    hero.className = 'hero stale';
    $('hero-title').textContent = 'Waiting for first check';
    $('hero-sub').textContent = 'The GitHub Actions poller has not reported yet.';
  } else if (available.length) {
    hero.className = 'hero in';
    $('hero-title').textContent = `${available.length} model${available.length > 1 ? 's' : ''} in stock`;
    $('hero-sub').textContent = available.map((p) => `${p.capacity} ${p.color}`).join(' · ');
  } else {
    hero.className = `hero ${stale ? 'stale' : 'out'}`;
    $('hero-title').textContent = 'Currently unavailable';
    $('hero-sub').textContent = `No iPhone Duo pickup stock at this store.${stale ? ' (data may be stale)' : ''}`;
  }

  $('grid').innerHTML = parts
    .map(
      (p) => `
      <article class="sku ${p.available ? 'in' : ''}">
        <div class="cap">${esc(p.capacity)}</div>
        <div class="color"><span class="swatch ${slug(p.color)}"></span>${esc(p.color)}</div>
        <span class="badge">${p.available ? 'In stock' : 'Unavailable'}</span>
        <span class="since">${p.since ? `since ${timeAgo(p.since)}` : ''}</span>
      </article>`,
    )
    .join('');

  $('nearby').innerHTML =
    (status.nearby ?? [])
      .map(
        (s) => `<li><span>${esc(s.name)} <span class="muted small">${esc(s.distance)}</span></span>
        <span class="${s.available.length ? 'ok' : 'no'}">${s.available.length ? `${s.available.length} in stock` : 'None'}</span></li>`,
      )
      .join('') || '<li class="muted">No data yet</li>';

  $('events').innerHTML =
    (status.events ?? [])
      .filter((e) => e.storeNumber === status.store?.number || e.available)
      .slice(0, 20)
      .map(
        (e) => `<li><span>${esc(e.name)}${e.storeNumber !== status.store?.number ? ` <span class="muted small">@ ${esc(e.store)}</span>` : ''}</span>
        <span class="${e.available ? 'ok' : 'no'}">${e.available ? 'In stock' : 'Sold out'} · ${timeAgo(e.at)}</span></li>`,
      )
      .join('') || '<li class="muted">No changes recorded yet</li>';

  const err = status.lastError ? ` · last error: ${status.lastError.message} (${timeAgo(status.lastError.at)})` : '';
  $('meta').textContent = `Last checked ${timeAgo(status.lastSuccessAt)} · page built ${timeAgo(status.generatedAt)}${err}`;

  if ('setAppBadge' in navigator) {
    (available.length ? navigator.setAppBadge(available.length) : navigator.clearAppBadge()).catch(() => {});
  }
}

// Fallback in-app alert while the app is open and this device has no server push.
async function maybeLocalNotify(status) {
  const nowAvail = (status.parts ?? []).filter((p) => p.available).map((p) => p.part);
  const before = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
  localStorage.setItem(SEEN_KEY, JSON.stringify(nowAvail));
  const fresh = (status.parts ?? []).filter((p) => p.available && !before.includes(p.part));
  if (!fresh.length || !swReg || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (await swReg.pushManager?.getSubscription()) return;
  for (const p of fresh) {
    swReg.showNotification(`🟢 ${p.name} in stock!`, { body: `Available at ${status.store?.name}.`, tag: p.part, icon: 'icons/icon-192.png', data: { url: status.productUrl } });
  }
}

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscriptionId(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function showSubscription(sub) {
  const json = JSON.stringify(sub.toJSON(), null, 2);
  const id = await subscriptionId(sub.endpoint);
  const repo = appConfig.repository;
  $('sub-save').href = `https://github.com/${repo}/new/main?filename=${encodeURIComponent(`subscriptions/${id}.json`)}&value=${encodeURIComponent(json)}`;
  $('sub-copy').onclick = async () => {
    await navigator.clipboard.writeText(json);
    $('sub-copy').textContent = 'Copied ✓';
  };
  $('sub-panel').hidden = false;
}

async function refreshNotifyUI() {
  const sub = swReg && (await swReg.pushManager.getSubscription());
  const perm = Notification.permission;
  if (sub) {
    $('notify-status').textContent = `On · device id ${await subscriptionId(sub.endpoint)}`;
    $('notify-btn').textContent = 'Turn off';
    await showSubscription(sub);
  } else {
    $('notify-status').textContent = perm === 'denied' ? 'Blocked — enable in Settings › Notifications › Duo Stock' : 'Off';
    $('notify-btn').textContent = 'Enable notifications';
    $('sub-panel').hidden = true;
  }
  $('notify-btn').disabled = perm === 'denied' || !appConfig.vapidPublicKey;
  if (!appConfig.vapidPublicKey) $('notify-status').textContent = 'Push not configured yet (run npm run setup-push).';
}

async function toggleNotifications() {
  const existing = await swReg.pushManager.getSubscription();
  if (existing) {
    await existing.unsubscribe();
    return refreshNotifyUI();
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return refreshNotifyUI();
  const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(appConfig.vapidPublicKey) });
  await swReg.showNotification('Notifications enabled', { body: 'Now tap “Save device on GitHub” to finish.', icon: 'icons/icon-192.png', tag: 'setup' });
  await refreshNotifyUI();
}

function schedule() {
  clearInterval(timer);
  if (document.visibilityState === 'visible') timer = setInterval(loadStatus, POLL_MS);
}

async function init() {
  try {
    appConfig = await (await fetch(`app-config.json?t=${Date.now()}`, { cache: 'no-store' })).json();
  } catch {
    appConfig = {};
  }

  if ('serviceWorker' in navigator) {
    swReg = await navigator.serviceWorker.register('sw.js').catch(() => null);
    if (swReg) await navigator.serviceWorker.ready;
  }

  if (isIOS && !isStandalone) $('install').hidden = false;
  if (pushSupported && swReg && (isStandalone || !isIOS)) {
    $('notify').hidden = false;
    $('notify-btn').onclick = () => toggleNotifications().catch((e) => ($('notify-status').textContent = `Error: ${e.message}`));
    await refreshNotifyUI();
  }

  $('refresh').onclick = loadStatus;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadStatus();
    schedule();
  });
  await loadStatus();
  schedule();
}

init();
