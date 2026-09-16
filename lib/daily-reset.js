/** Calendar day owning this instant. 04:00 is a calendar boundary, not a 24h timer. */
export function contextDay(now = Date.now(), timeZone = 'Asia/Macau', hour = 4) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Invalid reset hour');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (Number(parts.hour) < hour) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}
