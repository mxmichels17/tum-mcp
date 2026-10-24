// Collection scope, set by the owner (0.7.2). Items outside it are never read, and stored ones are forgotten
// without a delta (store.forget).
// - Mail (all folders) and the Zulip history: from MAIL_SINCE on.
// - Moodle: the courses listed in config/moodle-courses.json (units/moodle.ts).
// - Artemis and TUM-Live: only courses of the current semester.

/** First day of the mail and Zulip scope (Europe/Berlin day). */
export const MAIL_SINCE = "2026-09-15";

/** Start of MAIL_SINCE in Berlin as Unix seconds (Zulip timestamps). */
export const MAIL_SINCE_UNIX = Date.parse(`${MAIL_SINCE}T00:00:00+02:00`) / 1000;

/** MAIL_SINCE as an IMAP date for SEARCH SINCE (the server's internal date of the mail). */
export function imapSince(day = MAIL_SINCE): string {
	const [y, m, d] = day.split("-").map(Number);
	return `${d}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]}-${y}`;
}

export interface Semester {
	/** "WS26/27" or "SS27", the form Artemis uses. */
	code: string;
	/** First and last day of the semester (TUM: winter 1 October to 31 March, summer 1 April to 30 September). */
	start: string;
	end: string;
}

/** The TUM semester of a day. */
export function semesterOf(now = new Date()): Semester {
	const y = now.getUTCFullYear();
	const m = now.getUTCMonth() + 1;
	if (m >= 4 && m <= 9) return { code: `SS${String(y).slice(2)}`, start: `${y}-04-01`, end: `${y}-09-30` };
	const first = m >= 10 ? y : y - 1;
	return { code: `WS${String(first).slice(2)}/${String(first + 1).slice(2)}`, start: `${first}-10-01`, end: `${first + 1}-03-31` };
}

/** Courses often open some weeks before the lectures. A course that starts this long before the semester belongs to it. */
const EARLY_START_DAYS = 45;

/** True when a course start date (ISO string or Unix seconds) lies in the semester, counting EARLY_START_DAYS before its start. */
export function startsInSemester(start: string | number | null | undefined, sem = semesterOf()): boolean {
	if (start === null || start === undefined || start === "" || start === 0) return false;
	const t = typeof start === "number" ? start * 1000 : Date.parse(start);
	if (Number.isNaN(t)) return false;
	const from = Date.parse(`${sem.start}T00:00:00Z`) - EARLY_START_DAYS * 86400_000;
	const to = Date.parse(`${sem.end}T23:59:59Z`);
	return t >= from && t <= to;
}

/** Semester names compare without spaces and case ("WS 26/27" = "ws26/27"). */
export const sameSemester = (a: string, b: string) => a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
