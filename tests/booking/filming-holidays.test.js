const test = require('node:test');
const assert = require('node:assert/strict');
const { windowsFor, offeredDates, buildSlots } = require('../../functions-booking/sponsorship-schedule');

test('actual and observed federal holidays take precedence over all filming windows', () => {
    const window = { start: '12:00', end: '18:00' };
    const config = { windows: [], availabilityMode: 'weekly', timeZone: 'America/Los_Angeles',
        weeklyWindows: Array.from({ length: 7 }, (_, day) => ({ day, ...window })),
        package: { durationMinutes: 120 }, leadHours: 0, bufferBefore: 0, bufferAfter: 0 };
    const dates = ['2026-01-01','2026-01-19','2026-02-16','2026-05-25','2026-06-19','2026-07-03',
        '2026-07-04','2026-09-07','2026-10-12','2026-11-11','2026-11-26','2026-12-25',
        '2027-07-05','2027-12-31','2028-01-01'];
    for (const date of dates) {
        assert.deepEqual(windowsFor(config, date), [], date);
        assert.deepEqual(windowsFor({ ...config, windows: [{ date, ...window }] }, date), [], date);
    }
    const now = Date.parse('2026-11-24T20:00:00Z');
    assert(!offeredDates(config, now).includes('2026-11-26'));
    assert.deepEqual(buildSlots(config, '2026-11-26', [], {}, now), []);
    assert(buildSlots(config, '2026-11-25', [], {}, now).length > 0);
});
