/**
 * Browsers that came back: an anonymous cookie (a random id) and, per id, when it was
 * first and last seen, how many pages it opened and which accounts it signed up.
 * No address, no agent string, nothing else. Kept in DATA_DIR/visitors.json, pruned
 * after VISITOR_KEEP_DAYS and capped in size, for the admin page.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dataPath } from './paths.js';

const FILE = dataPath('visitors.json');
const KEEP_DAYS = Number(process.env.VISITOR_KEEP_DAYS ?? 180);
const MAX = 20000;
export const VISITOR_RE = /^[0-9a-f]{20}$/;

let all = new Map();
try { all = new Map(JSON.parse(readFileSync(FILE, 'utf8'))); } catch { /* none yet */ }
let timer = null;
const save = () => {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    for (const [id, v] of all) if (v.last < cutoff) all.delete(id);
    while (all.size > MAX) all.delete(all.keys().next().value);
    try { writeFileSync(FILE, JSON.stringify([...all]), { mode: 0o600 }); } catch (e) { console.warn('visitors save failed:', e.message); }
  }, 2000);
  timer.unref?.();
};

export const newVisitorId = () => randomBytes(10).toString('hex');

/** A page view by this browser. Returns its record (a copy of it before this visit is `before`). */
export function visit(id) {
  if (!VISITOR_RE.test(String(id || ''))) return null;
  const now = Date.now();
  const v = all.get(id) || { first: now, last: now, visits: 0, accounts: [] };
  v.visits++; v.last = now;
  all.delete(id); all.set(id, v); // most recent last, so the cap drops the stalest
  save();
  return v;
}

export function addAccount(id, accountId) {
  const v = all.get(id); if (!v) return;
  if (!v.accounts.includes(accountId)) v.accounts = [...v.accounts, accountId].slice(-20);
  save();
}

export const get = (id) => all.get(id) || null;
