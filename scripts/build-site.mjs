#!/usr/bin/env node
// Copies site/ into _site/ and writes app-config.json for the PWA.
// Env: VAPID_PUBLIC_KEY, GITHUB_REPOSITORY, OUT_DIR
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.env.OUT_DIR || '_site');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.cpSync(path.join(ROOT, 'site'), OUT_DIR, { recursive: true });

const appConfig = {
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  repository: process.env.GITHUB_REPOSITORY || 'darrenhum/iphone-stock',
  storeName: config.storeName,
  storeCity: config.storeCity,
  productName: config.productName,
  productUrl: config.productUrl,
  pollWorkflow: 'stock.yml',
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(OUT_DIR, 'app-config.json'), JSON.stringify(appConfig, null, 2));

// Bust the service-worker cache whenever the site is rebuilt.
const swPath = path.join(OUT_DIR, 'sw.js');
fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8').replace('__BUILD_ID__', Date.now().toString(36)));

if (!fs.existsSync(path.join(OUT_DIR, 'history.json'))) {
  fs.writeFileSync(path.join(OUT_DIR, 'history.json'), JSON.stringify({ restocks: [], parts: config.parts }));
}
if (!fs.existsSync(path.join(OUT_DIR, 'status.json'))) {
  fs.writeFileSync(path.join(OUT_DIR, 'status.json'), JSON.stringify({ generatedAt: null, parts: [], nearby: [], events: [] }));
}
console.log(`Built site into ${path.relative(ROOT, OUT_DIR)}/`);
