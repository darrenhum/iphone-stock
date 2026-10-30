# Duo Stock · Apple Bayshore

An [InStock Radar](https://instockradar.com/ca/store/bayshoreshoppingcentre)-style tracker for **iPhone Duo** in-store pickup at **Apple Bayshore Shopping Centre (R490), Ottawa**. It is hosted on GitHub Pages, can be added to the iOS Home Screen as a PWA, and sends iOS push notifications when stock appears.

**Site:** https://darrenhum.github.io/iphone-stock/

## How it works

```
GitHub Actions (cron, check every ~20 s) ──► Apple pickup feed
        │  diff vs. last state (actions/cache)
        ├──► Web Push (VAPID) ──► iOS Home Screen app notification
        └──► status.json + history.json + PWA ──► GitHub Pages
```

- **Endpoint:** `https://www.apple.com/ca/shop/retail/pickup-message?pl=true&location=K2B%208C1&parts.0=…`. This is Apple's retail pickup feed, the same one InStock Radar and [Duo-Scanner](https://github.com/VanniDevAI/Duo-Scanner) use. Apple doesn't send CORS headers, so a browser can't call the endpoint directly. The poller runs in GitHub Actions instead.
- **Models** (`config.json`): all 8 Canadian SKUs, taken from apple.com/ca:

  | | Star White | Night Sky |
  |---|---|---|
  | 256GB | MK244VC/A | MK254VC/A |
  | 512GB | MK264VC/A | MK274VC/A |
  | 1TB | MK284VC/A | MK294VC/A |
  | 2TB | MK2A4VC/A | MK2C4VC/A |

- **Restock history:** every Bayshore restock (unavailable → in stock) is logged with its start time, sell-out time and time in stock. The page shows per-model counts, a filterable history list, and an hour-of-day chart (Ottawa time). The log is saved to the Actions cache and published as `history.json`. If the cache is evicted, the poller re-seeds the log from the live site, so history is never lost.
- You get an alert when a Bayshore model changes from unavailable to available (`alertStores` in `config.json`). Nearby stores show on the page but don't send alerts.

## One-time setup

1. **Turn on Pages:** go to *Settings → Pages → Build and deployment* and set **Source: GitHub Actions**.
   Pages on a private repo needs a paid plan. On the free plan, make the repo public. Public repos also get unlimited Actions minutes. Each run takes about 5 minutes and runs up to 288 times a day.
2. **Create push keys** on a machine where `gh` is logged in:
   ```bash
   npm ci && npm run setup-push
   ```
   This saves the `VAPID_PRIVATE_KEY` secret and the `VAPID_PUBLIC_KEY` variable, then redeploys.

   **No computer?** Open https://darrenhum.github.io/iphone-stock/setup.html (this works on iPhone too). It generates the keys in your browser and links straight to GitHub's *New secret* and *New variable* pages. Paste the two values there, then run the workflow.
3. **On your iPhone (iOS 16.4+):**
   1. Open the site in Safari, tap **Share → Add to Home Screen**, then open **Duo Stock** from the Home Screen.
   2. Tap **Enable notifications** and allow them.
   3. Tap **Save device on GitHub** and commit the prefilled file. It goes into `subscriptions/`.
   4. The commit starts a run that sends a **test notification** to the new device.

To send a test later, open *Actions → Stock check & deploy → Run workflow* and tick **test_push**.

## Options

| Setting | Where | Default / purpose |
|---|---|---|
| `POLL_INTERVAL_SECONDS` | repo variable | `20` seconds between checks (min 10) |
| `POLL_DURATION_SECONDS` | repo variable | `240`, how long each scheduled run keeps polling |
| `PUSH_SUBSCRIPTIONS` | repo secret | JSON array of subscriptions, if you'd rather not commit them |
| `NTFY_TOPIC` | repo secret | Optional backup alerts via [ntfy](https://ntfy.sh) |
| `VAPID_SUBJECT` | repo variable | Defaults to the site URL |

To watch a different store, change `storeNumber`, `location` and `alertStores` in `config.json`.

## Development

```bash
npm ci
npm test                 # parser/diff unit tests
npm run check            # one live check -> _site/status.json
npm run build-site       # assemble _site/
python3 -m http.server -d _site
```

## Limitations

- GitHub cron is best-effort, and runs can be delayed when GitHub is busy. Each scheduled run checks every ~20 s for 4 minutes, so there are about 3 checks a minute. The website updates when each run ends, about every 5 minutes. Push alerts go out immediately.
- Apple can rate-limit runner IPs (HTTP 541). When that happens, the run stops early and the next run tries again on a fresh runner IP. If you see 541s often, raise `POLL_INTERVAL_SECONDS`.
- GitHub disables scheduled workflows after 60 days with no repository activity.
- An alert only reflects Apple's feed at that moment and doesn't hold a phone for you. Buy in the Apple Store app.
