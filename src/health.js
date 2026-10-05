/**
 * The server's own vital signs, for the admin page: how full the data volume is (in space
 * and in files — a volume runs out of inodes long before it runs out of bytes when it holds
 * many small files), how much memory the process uses, and what has gone wrong since it
 * started: writes the disk refused, sign-ups that were turned away. Counts only, in memory.
 */
import { statfsSync } from 'node:fs';
import v8 from 'node:v8';
import { dataDir } from './paths.js';

const startedAt = Date.now();
// Things that happen, counted since the start: a leak tends to follow one of them.
const counts = {};
export const bump = (name, by = 1) => { counts[name] = (counts[name] || 0) + (Number(by) || 0); };
// Kinds of object worth counting when memory climbs; filled in by whoever knows the classes (see app.js).
const census = new Map();
export const watchObjects = (name, ctor) => { if (typeof ctor === 'function') census.set(name, ctor); };
// Counting walks the whole heap, so it is only done while the heap is small enough for that to be quick.
const CENSUS_MAX_HEAP = 4e9;
const DISK_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EIO', 'EMFILE', 'ENFILE']);
const disk = { failures: 0, lastCode: null, lastAt: null };
const turnedAway = { full: 0, waiting: 0, rate: 0, lastAt: null };

/** Any error, from anywhere: counted if it is the disk saying no. */
export function noteError(e) {
  const code = e?.code || (String(e?.message || e).match(/\b(ENOSPC|EDQUOT|EROFS|EIO|EMFILE|ENFILE)\b/) || [])[1];
  if (!DISK_CODES.has(code)) return false;
  disk.failures++; disk.lastCode = code; disk.lastAt = Date.now();
  return true;
}
/** A sign-up that did not get an account: 'full' (capacity), 'waiting' (too many unscanned), 'rate' (per-address limit). */
export function noteTurnedAway(why) { if (why in turnedAway) { turnedAway[why]++; turnedAway.lastAt = Date.now(); } }

const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) : null);
/** Space and file slots on the data volume; null where the platform cannot say. Pure given a statfs result; exported for tests. */
export function diskUsage(stat = (() => { try { return statfsSync(dataDir); } catch { return null; } })()) {
  if (!stat) return null;
  const n = (v) => Number(v);
  return {
    spacePct: pct(n(stat.blocks) - n(stat.bfree), n(stat.blocks)), freeMb: Math.round((n(stat.bavail) * n(stat.bsize)) / 1e6),
    filesPct: pct(n(stat.files) - n(stat.ffree), n(stat.files)), filesUsed: n(stat.files) - n(stat.ffree), filesFree: n(stat.ffree),
  };
}

export function snapshot() {
  const mem = process.memoryUsage();
  return {
    startedAt, uptimeMinutes: Math.round((Date.now() - startedAt) / 60e3),
    memoryMb: Math.round(mem.rss / 1e6),
    // Which kind of memory it is: objects on the JS heap, or bytes held outside it (buffers: media, protocol frames).
    memory: { heapUsedMb: Math.round(mem.heapUsed / 1e6), heapTotalMb: Math.round(mem.heapTotal / 1e6), buffersMb: Math.round((mem.external + mem.arrayBuffers) / 1e6) },
    disk: diskUsage(), diskFailures: { ...disk }, turnedAway: { ...turnedAway },
  };
}
/**
 * One line for the log, every few minutes: what kind of memory is in use and how many timers and
 * sockets the process holds. A leak shows in which of these keeps climbing while accounts do not.
 */
export function memoryLine(accounts = null) {
  const mem = process.memoryUsage(), gb = (n) => (n / 1e9).toFixed(2);
  const held = {};
  try { for (const kind of process.getActiveResourcesInfo()) held[kind] = (held[kind] || 0) + 1; } catch { /* older Node */ }
  const top = Object.entries(held).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}`).join(', ');
  let alive = '';
  if (census.size && typeof v8.queryObjects === 'function' && mem.heapUsed < CENSUS_MAX_HEAP) {
    try { alive = ` · alive: ${[...census].map(([name, ctor]) => `${name} ${v8.queryObjects(ctor, { format: 'count' })}`).join(', ')}`; } catch { /* not on this Node */ }
  }
  const since = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ');
  return `🧠 memory ${gb(mem.rss)} GB (heap ${gb(mem.heapUsed)} of ${gb(mem.heapTotal)}, buffers ${gb(mem.external + mem.arrayBuffers)})${accounts ? ` · ${accounts.total} accounts, ${accounts.connected} connected` : ''} · up ${Math.round((Date.now() - startedAt) / 60e3)}m · holding: ${top || 'n/a'}${since ? ` · since start: ${since}` : ''}${alive}`;
}
export const _reset = () => { Object.assign(disk, { failures: 0, lastCode: null, lastAt: null }); Object.assign(turnedAway, { full: 0, waiting: 0, rate: 0, lastAt: null }); }; // tests
