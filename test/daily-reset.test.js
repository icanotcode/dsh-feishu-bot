import test from 'node:test';
import assert from 'node:assert/strict';
import { contextDay } from '../lib/daily-reset.js';

test('Macau daily context changes exactly at 04:00, including month, leap-day and year boundaries', () => {
  for (const [instant, expected] of [
    ['2026-09-15T19:59:59.999Z', '2026-09-15'],
    ['2026-09-15T20:00:00.000Z', '2026-09-16'],
    ['2026-09-15T20:00:00.001Z', '2026-09-16'],
    ['2026-09-16T00:00:00+08:00', '2026-09-15'],
    ['2026-01-01T03:59:59+08:00', '2025-12-31'],
    ['2024-03-01T03:59:59+08:00', '2024-02-29'],
    ['2025-03-01T03:59:59+08:00', '2025-02-28'],
  ]) assert.equal(contextDay(instant), expected, instant);
});

test('calendar rotation follows local wall clock across short and long DST days', () => {
  const zone = 'America/New_York';
  for (const [instant, expected] of [
    ['2026-03-08T06:59:59Z', '2026-03-07'],
    ['2026-03-08T07:00:00Z', '2026-03-07'],
    ['2026-03-08T07:59:59Z', '2026-03-07'],
    ['2026-03-08T08:00:00Z', '2026-03-08'],
    ['2026-11-01T05:30:00Z', '2026-10-31'],
    ['2026-11-01T06:30:00Z', '2026-10-31'],
    ['2026-11-01T08:59:59Z', '2026-10-31'],
    ['2026-11-01T09:00:00Z', '2026-11-01'],
  ]) assert.equal(contextDay(instant, zone), expected, instant);
});

test('configured reset hour and timezone are respected and invalid values fail explicitly', () => {
  assert.equal(contextDay('2026-09-16T00:00:00Z', 'UTC', 0), '2026-09-16');
  assert.equal(contextDay('2026-09-16T22:59:59Z', 'UTC', 23), '2026-09-15');
  assert.equal(contextDay('2026-09-16T23:00:00Z', 'UTC', 23), '2026-09-16');
  assert.equal(contextDay('2026-09-15T22:15:00Z', 'Asia/Kathmandu', 4), '2026-09-16');
  for (const hour of [-1, 24, 3.5, '4']) assert.throws(() => contextDay(Date.now(), 'Asia/Macau', hour), /reset hour/);
  assert.throws(() => contextDay(Date.now(), 'Invalid/Zone'), RangeError);
  assert.throws(() => contextDay('not a date'), RangeError);
});
