import assert from 'node:assert/strict';
import { parseReminderPrompt } from '../lib/reminder-input';
import { nextReminderLocal, reminderInstant } from '../lib/reminder-time';

assert.deepEqual(parseReminderPrompt('Напомни ми да изпратя отчета на 2027-01-30 в 10:00 Europe/Sofia всяка седмица.'), {
  text: 'изпратя отчета', localTime: '2027-01-30T10:00', timeZone: 'Europe/Sofia', repeat: 'WEEKLY',
});
assert.deepEqual(parseReminderPrompt('Remind me to send the report on 2027-01-30 at 10:00 America/New_York every month.'), {
  text: 'send the report', localTime: '2027-01-30T10:00', timeZone: 'America/New_York', repeat: 'MONTHLY',
});
assert.equal(parseReminderPrompt('Напомни: Отчет | 2027-01-30T10:00 | UTC | DAILY')?.repeat, 'DAILY');
assert.equal(parseReminderPrompt('Remind me someday'), null);
assert.equal(parseReminderPrompt('Напомни ми да проверя календара утре в 09:00 Europe/Sofia',
  new Date('2027-01-30T23:30:00.000Z'))?.localTime, '2027-02-01T09:00');
assert.equal(reminderInstant('2027-01-30T10:00', 'Europe/Sofia')?.toISOString(), '2027-01-30T08:00:00.000Z');
assert.equal(reminderInstant('2027-01-30T10:00', 'Asia/Kathmandu')?.toISOString(), '2027-01-30T04:15:00.000Z');
assert.equal(reminderInstant('2027-02-30T10:00', 'UTC'), null);
assert.equal(reminderInstant('2027-03-28T03:30', 'Europe/Sofia'), null);
assert.equal(reminderInstant('2027-03-28T03:30', 'Europe/Sofia', true)?.toISOString(), '2027-03-28T01:30:00.000Z');
assert.equal(reminderInstant('2027-10-31T03:30', 'Europe/Sofia', true)?.toISOString(), '2027-10-31T00:30:00.000Z');
assert.equal(nextReminderLocal('2027-03-27T03:30', '2027-03-27T03:30', 'DAILY'), '2027-03-28T03:30');
assert.equal(nextReminderLocal('2027-12-28T12:00', '2027-12-28T12:00', 'WEEKLY'), '2028-01-04T12:00');
assert.equal(nextReminderLocal('2027-01-31T08:00', '2027-01-31T08:00', 'MONTHLY'), '2027-02-28T08:00');
assert.equal(nextReminderLocal('2027-02-28T08:00', '2027-01-31T08:00', 'MONTHLY'), '2027-03-31T08:00');
console.log('Reminder date and recurrence checks passed for calendar boundaries, offset zones, DST gaps and overlap.');
