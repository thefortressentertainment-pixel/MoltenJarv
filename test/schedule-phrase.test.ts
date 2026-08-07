import assert from 'node:assert';
import { test } from 'node:test';
import { schedulePhraseToCron } from '../src/scheduler/phrase.js';
import { parseCron } from '../src/scheduler/cron.js';

/** Helper: assert a phrase parses to a cron AND that cron is itself valid. */
function check(phrase: string, expected: string): void {
  const got = schedulePhraseToCron(phrase);
  assert.strictEqual(got, expected, `expected "${expected}" for "${phrase}", got "${got}"`);
  parseCron(got); // must not throw
}

test('phrase: daily cadences', () => {
  check('daily at 7am', '0 7 * * *');
  check('daily at 09:30', '30 9 * * *');
  check('every day at noon', '0 12 * * *');
  check('daily', '0 0 * * *');
  check('every day', '0 0 * * *');
  check('at 8', '0 8 * * *');
  check('daily at midnight', '0 0 * * *');
});

test('phrase: named cadences', () => {
  check('hourly', '0 * * * *');
  check('weekly', '0 0 * * 0');
  check('monthly', '0 0 1 * *');
  check('once a month', '0 0 1 * *');
});

test('phrase: weekdays / weekday / weekend', () => {
  check('every monday at 5pm', '0 17 * * 1');
  check('every friday', '0 0 * * 5');
  check('every saturday at 7am', '0 7 * * 6');
  check('weekdays at 8', '0 8 * * 1-5');
  check('weekends at noon', '0 12 * * 0,6');
  check('every tuesday at 06:15', '15 6 * * 2');
});

test('phrase: intervals', () => {
  check('every 4 hours', '0 */4 * * *');
  check('4-hourly', '0 */4 * * *');
  check('hourly', '0 * * * *');
  check('every 30 minutes', '*/30 * * * *');
  check('every 2 hours', '0 */2 * * *');
});

test('phrase: monthly day-of-month', () => {
  check('monthly on the 1st at 8am', '0 8 1 * *');
  check('monthly on the 15th at 06:00', '0 6 15 * *');
  check('on the 30th at 9pm', '0 21 30 * *');
});

test('phrase: month-of-year', () => {
  check('january at 8am', '0 8 1 1 *');
  check('october on the 10th at 7', '0 7 10 10 *');
});

test('phrase: errors are descriptive (fail-closed)', () => {
  assert.throws(() => schedulePhraseToCron(''), /empty/);
  assert.throws(() => schedulePhraseToCron('banana at 25pm'), /could not parse/);
  assert.throws(() => schedulePhraseToCron('nonsense'), /could not parse/);
  assert.throws(() => schedulePhraseToCron('daily at 25pm'), /out of range/);
  assert.throws(() => schedulePhraseToCron('every 60 minutes'), /must be <= 59/);
  assert.throws(() => schedulePhraseToCron('every 100 hours'), /must be <= 23/);
});
