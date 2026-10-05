// node --test test/connectgate.test.mjs — connections are opened a few at a time, newest accounts first (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.CONNECT_CONCURRENCY = '10';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-gate-'));
const { connectSlot, connectQueue, jitter } = await import('../src/connectgate.js');

test('three hundred accounts coming back at once: never more than ten attempts in flight, in the order they asked', async () => {
  let inFlight = 0, peak = 0; const order = [];
  await Promise.all(Array.from({ length: 300 }, async (_, i) => {
    const release = await connectSlot();
    order.push(i); inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2)); // the socket gets its answer
    inFlight--; release(); release(); // twice: open and then close both give it back, once
  }));
  assert.equal(peak, 10); assert.deepEqual(order, Array.from({ length: 300 }, (_, i) => i));
  assert.deepEqual(connectQueue(), { inFlight: 0, waiting: 0 });
});

test('an attempt that never gets an answer gives its slot back on its own', async () => {
  const held = await Promise.all(Array.from({ length: 10 }, () => connectSlot(30)));
  const started = Date.now(); const next = await connectSlot(30); // only free once the ten time out
  assert.ok(Date.now() - started >= 20, 'waited for a slot'); next(); held.forEach((r) => r());
  await new Promise((r) => setTimeout(r, 5)); // the slots are handed back on the next turn
  assert.deepEqual(connectQueue(), { inFlight: 0, waiting: 0 });
});

test('sockets that dropped together do not come back together', () => {
  const delays = Array.from({ length: 200 }, () => jitter(8000));
  assert.ok(Math.min(...delays) >= 4800 && Math.max(...delays) <= 11200);
  assert.ok(new Set(delays).size > 150, 'spread out, not one instant');
  assert.equal(jitter(2000, () => 0), 1200); assert.equal(jitter(2000, () => 1), 2800);
});

test('after a restart the most recently linked accounts are started first', async () => {
  const registry = await import('../src/registry.js');
  const started = [];
  const mk = (label, linkedAt) => { const t = registry.create({ label, start: false }); t.linkedAt = linkedAt; t.start = async () => { started.push(label); }; return t; };
  mk('linked last week', Date.now() - 7 * 864e5); mk('linked a minute ago', Date.now() - 60e3); mk('linked an hour ago', Date.now() - 3600e3);
  await registry.startAll();
  assert.deepEqual(started.slice(0, 3), ['linked a minute ago', 'linked an hour ago', 'linked last week']);
});

test('the memory line measures stalls and collections without causing one', async () => {
  const { memoryLine } = await import('../src/health.js');
  const ballast = Array.from({ length: 2_000_000 }, (_, i) => ({ i, s: 'x' + i })); // a few hundred MB of live objects
  const t0 = performance.now(); const line = memoryLine({ total: 300, connected: 250 }); const took = performance.now() - t0;
  assert.ok(took < 50, `took ${took.toFixed(1)}ms`); assert.ok(ballast.length);
  assert.match(line, /longest stall \d+\.\ds · gc: \d+ full, longest \d+ms/);
  assert.ok(!/alive:/.test(line));
});
