#!/usr/bin/env node
// One-time setup: generates VAPID keys and stores them in the GitHub repo
// (secret VAPID_PRIVATE_KEY + variable VAPID_PUBLIC_KEY) using the gh CLI.
import { execFileSync } from 'node:child_process';
import webpush from 'web-push';

const repo = process.argv[2] || process.env.GITHUB_REPOSITORY || 'darrenhum/iphone-stock';
const { publicKey, privateKey } = webpush.generateVAPIDKeys();

try {
  execFileSync('gh', ['secret', 'set', 'VAPID_PRIVATE_KEY', '-R', repo, '--body', privateKey], { stdio: 'inherit' });
  execFileSync('gh', ['variable', 'set', 'VAPID_PUBLIC_KEY', '-R', repo, '--body', publicKey], { stdio: 'inherit' });
  console.log(`\nSaved VAPID keys to ${repo}. Redeploying…`);
  execFileSync('gh', ['workflow', 'run', 'stock.yml', '-R', repo], { stdio: 'inherit' });
  console.log('Done. Open the site on your iPhone, Add to Home Screen, then tap "Enable notifications".');
} catch {
  console.log('\nCould not save automatically with gh. Add these manually in');
  console.log(`https://github.com/${repo}/settings/secrets/actions\n`);
  console.log(`  Secret   VAPID_PRIVATE_KEY = ${privateKey}`);
  console.log(`  Variable VAPID_PUBLIC_KEY  = ${publicKey}`);
}
