#!/usr/bin/env node
/**
 * Two caches inside the WhatsApp library are changed after `npm install`.
 *
 * Each connection keeps a cache of phone-number-to-id mappings, and one of migrated
 * sessions, with no size limit and a three-day expiry that is enforced by a separate
 * timer per entry. On a server with hundreds of accounts those timers were most of the
 * live memory: about a gigabyte an hour, growing until the process ran out. The library
 * has no option for it, so the two constructions are rewritten here to a bounded cache
 * without timers (stale entries are dropped when they are next touched or pushed out).
 *
 * Run after every install (the Dockerfile does; locally: `node scripts/patch-deps.mjs`).
 * Idempotent. Fails loudly when the library's code no longer matches, so an upgrade of
 * the library cannot silently lose the patch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Signal');
const MAX = 20_000; // entries per connection; a mapping is two short strings
const PATCHES = [
  { file: 'lid-mapping.js', from: '            ttl: 3 * 24 * 60 * 60 * 1000, // 7 days\n            ttlAutopurge: true,\n            updateAgeOnGet: true\n', to: `            ttl: 3 * 24 * 60 * 60 * 1000, // 7 days\n            max: ${MAX}, // ramble: bounded, no timer per entry (scripts/patch-deps.mjs)\n            ttlAutopurge: false,\n            updateAgeOnGet: true\n` },
  { file: 'libsignal.js', from: '        ttl: 3 * 24 * 60 * 60 * 1000, // 7 days\n        ttlAutopurge: true,\n        updateAgeOnGet: true\n', to: `        ttl: 3 * 24 * 60 * 60 * 1000, // 7 days\n        max: ${MAX}, // ramble: bounded, no timer per entry (scripts/patch-deps.mjs)\n        ttlAutopurge: false,\n        updateAgeOnGet: true\n` },
];
let changed = 0;
for (const p of PATCHES) {
  const path = join(root, p.file);
  const src = readFileSync(path, 'utf8');
  if (src.includes(p.to)) continue; // already applied
  if (!src.includes(p.from)) { console.error(`patch-deps: ${p.file} does not look as expected — the library changed; review scripts/patch-deps.mjs`); process.exit(1); }
  writeFileSync(path, src.replace(p.from, p.to));
  changed++;
}
console.log(`patch-deps: ${changed ? `${changed} file(s) patched` : 'already applied'}`);
