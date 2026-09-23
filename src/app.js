/**
 * Entry point: load every linked account, start them, serve the site.
 */
import './logguard.js'; // first: nothing may print session keys, from the first line on
import { dictateEnabled } from './dictate.js';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir, dataDirIsMount } from './paths.js';
import * as registry from './registry.js';
import { createWebApp } from './web.js';
import { PRODUCT_NAME, DEFAULT_PLAN, DAILY_MINUTES_CAP, MAX_TRANSCRIBE_SECONDS } from './tenant.js';
import { transcribeEnabled, planEnabled, planLabel } from './transcribe.js';
import { GLOBAL_DAILY_MINUTES, secondsToday } from './budget.js';
import * as research from './research.js';
import { rewriteEnabled, rewriteLabel, editorLabel } from './rewrite.js';
import { summarizeEnabled, summaryLabel } from './summarize.js';
import { llmFallbackLabel } from './llm.js';

// Everything this process writes (session keys, settings, media) is private to it.
process.umask(0o077);
// ffmpeg scratch files from a previous crash: remove anything older than an hour.
try { for (const f of readdirSync(tmpdir())) if (/^wa_\d+_[a-z0-9]+\.mp3$/.test(f)) { const p = join(tmpdir(), f); if (Date.now() - statSync(p).mtimeMs > 3600e3) unlinkSync(p); } } catch { /* best effort */ }

const PORT = Number(process.env.PORT ?? 4599);
const HOST = process.env.HOST || '127.0.0.1';

process.on('unhandledRejection', (e) => console.warn('⚠️  unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.warn('⚠️  uncaughtException:', e?.message || e));

console.log(`Starting ${PRODUCT_NAME}… (uid ${typeof process.getuid === 'function' ? process.getuid() : 'n/a'}${typeof process.getuid === 'function' && process.getuid() === 0 ? ' — ROOT; the container entrypoint should have dropped privileges' : ''})`);
if (!transcribeEnabled) console.error('❌ No transcription provider configured — nothing will be transcribed.');
console.log(`🎙️  Transcription per plan: pro → ${planLabel('pro')}${planEnabled('free') ? `, free → ${planLabel('free')}` : ''} · new accounts start on "${DEFAULT_PLAN}"${planEnabled('free') && planEnabled('pro') ? ' · a pro account falls back to the free provider only if its own fails' : ''}`);
console.log(`💰 Caps: ${DAILY_MINUTES_CAP || '∞'} min/day per account · ${GLOBAL_DAILY_MINUTES || '∞'} min/day for this server (${Math.round(secondsToday() / 60)} used today) · ${MAX_TRANSCRIBE_SECONDS ? `${Math.round(MAX_TRANSCRIBE_SECONDS / 60)} min` : 'no limit'} per recording · the same recording twice is free`);
console.log(`✍️  Rewrite: ${rewriteEnabled ? `pro = editor (${editorLabel}), free = faithful (${rewriteLabel})` : 'OFF (raw transcripts)'} · summary: ${summarizeEnabled ? summaryLabel : 'OFF'} · chat fallback: ${llmFallbackLabel || 'none'} · second reading for the rewrite: ${process.env.SECOND_READING_MODEL || 'off (single reading)'}`);
console.log(`✉️  Dictated messages: ${dictateEnabled ? 'ON — every one is confirmed by the owner before it is sent' : 'OFF'}`);
const mounted = dataDirIsMount();
if (mounted === false) console.error(`🚨 DATA_DIR ${dataDir} is NOT a mounted volume — every linked account will be LOST on the next restart.`);
else if (mounted === true) console.log(`💾 DATA_DIR ${dataDir}: mounted volume ✓`);

// Recordings kept by accounts that opted in: sweep by age and size, now and hourly.
research.sweep();
setInterval(() => research.sweep(), 3600e3).unref?.();
const kept = research.usage();
if (kept.files) console.log(`🎧 Kept recordings (opt-in): ${kept.files} file(s), ${Math.round(kept.bytes / 1e6)} MB across ${kept.accounts} account(s); pruned after ${research.RESEARCH_KEEP_DAYS} days or ${research.RESEARCH_MAX_MB} MB`);

registry.migrateLegacy();
const tenants = registry.loadAll();
console.log(`👥 ${tenants.length} linked account(s) (capacity ${registry.MAX_TENANTS})`);
registry.startAll();

createWebApp().listen(PORT, HOST, () => console.log(`🌐 Site: http://${HOST === '0.0.0.0' ? '<your-host>' : 'localhost'}:${PORT}  (admin at /admin${process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD ? '' : ' — disabled, set ADMIN_PASSWORD'})`));
