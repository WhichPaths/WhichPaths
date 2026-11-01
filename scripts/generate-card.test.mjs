import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function session(firstMessageAt, activeSeconds, lastMessageAt = firstMessageAt) {
  return { firstMessageAt, lastMessageAt, activeSeconds, durationSeconds: 43200,
    messageCount: 10, userMessageCount: 3 };
}

function generate(sessions) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-card-test-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    const script = join(dir, 'scripts/generate-card.mjs');
    copyFileSync(new URL('./generate-card.mjs', import.meta.url), script);
    const payload = { sessions, buckets: [{ bucketStart: '2026-11-01T00:00:00Z',
      inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, totalTokens: 3,
      estimatedCost: 0.01 }] };
    const preload = join(dir, 'fixture.mjs');
    writeFileSync(preload, `Date.now = () => Date.parse('2026-11-01T12:00:00Z');
      globalThis.fetch = async () => ({ ok: true, json: async () => (${JSON.stringify(payload)}) });`);
    const result = spawnSync(process.execPath, ['--import', preload, script], {
      encoding: 'utf8', env: { ...process.env, VIBE_USAGE_API_KEY: 'fixture-only-key' },
    });
    return { ...result, svg: result.status === 0 ? readFileSync(join(dir, 'vibe-usage-warm.svg'), 'utf8') : '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('counts sessions by their UTC+8 start hour within the 90-day window', () => {
  const { status, stderr, svg } = generate([
    session('2026-10-31T15:30:00Z', 5400, '2026-11-01T03:30:00Z'),
    session('2026-10-31T16:15:00Z', 900),
    session('2026-10-24T16:45:00Z', 4500),
    session('2026-11-01T01:00:00Z', 0),
    session('2026-08-03T00:00:00Z', 7200),
  ]);
  assert.equal(status, 0, stderr);
  assert.match(svg, /Hourly Activity/);
  assert.match(svg, /<title>Sat 23:00 \(UTC\+8\): 1 session</);
  assert.match(svg, /<title>Sun 00:00 \(UTC\+8\): 2 sessions/);
  assert.match(svg, /<title>Sun 09:00 \(UTC\+8\): 1 session</);
  const counts = [...svg.matchAll(/<title>\w+ \d{2}:00 \(UTC\+8\): (\d+) sessions?</g)]
    .map((match) => Number(match[1]));
  assert.equal(counts.length, 168);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 4);
  assert.ok(!svg.includes('active hours'), 'heatmap must count sessions instead of duration');
  assert.match(svg, /90-day dashboard/);
  assert.doesNotMatch(svg, /[\p{Script=Han}]/u);
});

test('rejects invalid active durations and timestamps instead of publishing misleading cells', () => {
  for (const invalid of [
    session('2026-11-01T00:00:00Z', -1),
    session('2026-11-01T00:00:00Z', null),
    session('invalid', 60),
  ]) {
    const result = generate([invalid]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid session (activeSeconds|firstMessageAt)/);
  }
});

test('carries rounded minutes into the next hour', () => {
  const { status, stderr, svg } = generate([session('2026-11-01T00:00:00Z', 3599)]);
  assert.equal(status, 0, stderr);
  assert.ok(svg.includes('1h 0m active'), '3599 active seconds should display as 1h 0m');
  assert.ok(!svg.includes('0h 60m'), 'formatted minutes must stay below 60');
});
