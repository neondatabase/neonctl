import { describe, test, expect } from 'vitest';

import {
  formatNumericLocale,
  formatByteSize,
  formatDurationBody,
  formatDurationMs,
} from './units.js';

describe('formatNumericLocale', () => {
  test('returns value unchanged when locale is off', () => {
    expect(formatNumericLocale('1234567', false)).toBe('1234567');
    expect(formatNumericLocale('1234567.89', false, 'en-US')).toBe(
      '1234567.89',
    );
  });

  test('inserts thousand separators with en-US locale', () => {
    expect(formatNumericLocale('1234567', true, 'en-US')).toBe('1,234,567');
    expect(formatNumericLocale('-1234567', true, 'en-US')).toBe('-1,234,567');
  });

  test('preserves the input fraction width', () => {
    expect(formatNumericLocale('1000.500', true, 'en-US')).toBe('1,000.500');
    expect(formatNumericLocale('0.10', true, 'en-US')).toBe('0.10');
  });

  test('uses locale decimal point', () => {
    // de-DE uses '.' as thousands sep and ',' as decimal.
    expect(formatNumericLocale('1234567.89', true, 'de-DE')).toBe(
      '1.234.567,89',
    );
  });

  test('passes through non-numeric strings untouched', () => {
    expect(formatNumericLocale('1e6', true, 'en-US')).toBe('1e6');
    expect(formatNumericLocale('NaN', true, 'en-US')).toBe('NaN');
    expect(formatNumericLocale('abc', true, 'en-US')).toBe('abc');
  });

  test('handles very large integers precisely', () => {
    expect(
      formatNumericLocale('123456789012345678901234567890', true, 'en-US'),
    ).toBe('123,456,789,012,345,678,901,234,567,890');
  });
});

describe('formatByteSize', () => {
  test('renders bytes regime with the SI unit name when requested', () => {
    expect(formatByteSize(0, { si: true })).toBe('0 B');
    expect(formatByteSize(0)).toBe('0 bytes');
    expect(formatByteSize(1)).toBe('1 bytes');
    expect(formatByteSize(10239)).toBe('10239 bytes');
  });

  test('promotes to kB once the value would otherwise render >= 10*1024 bytes', () => {
    expect(formatByteSize(10 * 1024)).toBe('10.0 kB');
    expect(formatByteSize(1024 * 1024)).toBe('1024.0 kB');
  });

  test('promotes through the unit ladder', () => {
    expect(formatByteSize(20 * 1024 * 1024)).toBe('20.0 MB');
    expect(formatByteSize(Math.round(1.5 * 1024 * 1024 * 1024))).toBe(
      '1536.0 MB',
    );
    expect(formatByteSize(50 * 1024 * 1024 * 1024)).toBe('50.0 GB');
  });

  test('handles negative byte counts', () => {
    expect(formatByteSize(-1024 * 1024)).toBe('-1024.0 kB');
  });
});

describe('formatDurationMs', () => {
  test('renders milliseconds when below one second', () => {
    expect(formatDurationMs(0.123)).toBe('Time: 0.123 ms');
    expect(formatDurationMs(12.345)).toBe('Time: 12.345 ms');
    expect(formatDurationMs(123.456)).toBe('Time: 123.456 ms');
    expect(formatDurationMs(0)).toBe('Time: 0.000 ms');
    expect(formatDurationMs(999.999)).toBe('Time: 999.999 ms');
  });

  test('renders seconds when below one minute', () => {
    expect(formatDurationMs(1000)).toBe('Time: 1.000 s');
    expect(formatDurationMs(12345)).toBe('Time: 12.345 s');
    expect(formatDurationMs(59999)).toBe('Time: 59.999 s');
  });

  test('renders minutes when below one hour', () => {
    expect(formatDurationMs(60_000)).toBe('Time: 1 m 0.000 s');
    expect(formatDurationMs(754_567)).toBe('Time: 12 m 34.567 s');
    expect(formatDurationMs(3_599_999)).toBe('Time: 59 m 59.999 s');
  });

  test('renders hours when at or above one hour', () => {
    expect(formatDurationMs(3_600_000)).toBe('Time: 1 h 0 m 0.000 s');
    expect(formatDurationMs(5_025_678)).toBe('Time: 1 h 23 m 45.678 s');
    // 25h 1m 0s
    expect(formatDurationMs(90_060_000)).toBe('Time: 25 h 1 m 0.000 s');
  });

  test('non-finite and negative inputs collapse to 0', () => {
    expect(formatDurationMs(NaN)).toBe('Time: 0.000 ms');
    expect(formatDurationMs(-5)).toBe('Time: 0.000 ms');
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe('Time: 0.000 ms');
  });
});

describe('formatDurationBody', () => {
  test('omits the `Time:` prefix', () => {
    expect(formatDurationBody(123)).toBe('123.000 ms');
    expect(formatDurationBody(5000)).toBe('5.000 s');
    expect(formatDurationBody(120_500)).toBe('2 m 0.500 s');
  });
});
