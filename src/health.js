/**
 * The server's own vital signs, for the admin page: how full the data volume is (in space
 * and in files — a volume runs out of inodes long before it runs out of bytes when it holds
 * many small files), how much memory the process uses, and what has gone wrong since it
 * started: writes the disk refused, sign-ups that were turned away. Counts only, in memory.
 */
import { statfsSync } from 'node:fs';
import { dataDir } from './paths.js';

const startedAt = Date.now();
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
  return {
    startedAt, uptimeMinutes: Math.round((Date.now() - startedAt) / 60e3),
    memoryMb: Math.round(process.memoryUsage().rss / 1e6),
    disk: diskUsage(), diskFailures: { ...disk }, turnedAway: { ...turnedAway },
  };
}
export const _reset = () => { Object.assign(disk, { failures: 0, lastCode: null, lastAt: null }); Object.assign(turnedAway, { full: 0, waiting: 0, rate: 0, lastAt: null }); }; // tests
