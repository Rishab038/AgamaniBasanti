// Dates, times and rupees — formatted once, from cached formatters.
//
// `date.toLocaleTimeString("en-IN", {...})` builds a fresh
// Intl.DateTimeFormat on every single call. Constructing the formatter
// is the expensive part by a wide margin; formatting with an existing
// one is cheap. Called per row, per render, on a phone with a slow CPU,
// that adds up for no reason — so the formatters are built once here and
// reused for the life of the app.
//
// Everything is Asia/Kolkata. The shop has one clock.

const IST = "Asia/Kolkata";

const timeFmt = new Intl.DateTimeFormat("en-IN", {
  hour: "numeric", minute: "2-digit", timeZone: IST,
});
const time12Fmt = new Intl.DateTimeFormat("en-IN", {
  hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST,
});
const dayFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric", month: "short", timeZone: IST,
});
const longDayFmt = new Intl.DateTimeFormat("en-IN", {
  weekday: "long", day: "numeric", month: "long", timeZone: IST,
});
const monthFmt = new Intl.DateTimeFormat("en-IN", {
  month: "long", year: "numeric", timeZone: IST,
});
// en-CA gives YYYY-MM-DD, which is what the database wants
const isoDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: IST });

// Deliberately NOT a shared `rupees()`. The three tabs disagree about
// money — one rounds to whole rupees, two take the absolute value, one
// does neither — and folding them together would quietly change what
// staff see. Only the cached formatter is shared; each caller keeps its
// own rule about signs and paise.
const moneyFmt = new Intl.NumberFormat("en-IN");
/** Indian digit grouping, from a formatter built once */
export const groupInr = (n: number) => moneyFmt.format(n);

const asDate = (t: string | number | Date) => (t instanceof Date ? t : new Date(t));

/** "3:42 pm" */
export const fmtTime = (t: string | number | Date) => time12Fmt.format(asDate(t));
/** "3:42 PM" without the 12-hour suffix styling — used in lists */
export const fmtClock = (t: string | number | Date) => timeFmt.format(asDate(t));
/** "2 Aug" */
export const fmtDay = (t: string | number | Date) => dayFmt.format(asDate(t));
/** "Saturday, 2 August" */
export const fmtLongDay = (t: string | number | Date) => longDayFmt.format(asDate(t));
/** "August 2026" */
export const fmtMonth = (t: string | number | Date) => monthFmt.format(asDate(t));
/** today in the shop's timezone, as YYYY-MM-DD */
export const istToday = () => isoDayFmt.format(new Date());
/** the IST calendar day a timestamp falls on, as YYYY-MM-DD */
export const istDay = (t: string | number | Date) => isoDayFmt.format(asDate(t));
