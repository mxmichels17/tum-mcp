// What works per platform, and what the platform blocks (and why). Shown by server_info.
// Keep in sync with docs/TECH.md.

export interface Capability {
	platform: string;
	works: string[];
	blocked: { what: string; why: string }[];
}

export const CAPABILITIES: Capability[] = [
	{
		platform: "mail (LRZ IMAP/SMTP)",
		works: ["folders: list, create, rename, delete empty", "search, read, attachments", "send, reply, forward, save draft", "move, flags, trash"],
		blocked: [
			{ what: "server-side filters (Sieve), out-of-office", why: "LRZ configures them in its web portal, there is no ManageSieve access for this server" },
			{ what: "permanent delete", why: "left out on purpose: mail_trash moves to Trash" },
		],
	},
	{
		platform: "zulip",
		works: [
			"messages: read with narrow and search, send to channel, DM, edit and delete own",
			"reactions, file upload",
			"mark read (messages, topic, channel)",
			"users: search, details",
			"subscriptions: list, subscribe, unsubscribe, mute, pin",
		],
		blocked: [{ what: "delete messages of others, admin settings", why: "Zulip permissions" }],
	},
	{
		platform: "tumonline (public)",
		works: ["course search, details, groups, dates, semesters", "exam dates with registration and deregistration periods for all TUM exams (tumonline_public_exams)"],
		blocked: [],
	},
	{
		platform: "tumonline (token, wbservicesbasic)",
		works: ["identity, grades, personal calendar, my courses, course details, person search and details, fee status", "raw read-only calls (tumonline_token_raw): kalender, noten, pruefungenEigene, veranstaltungenEigene, veranstaltungenDetails, veranstaltungenTermine, absNoten, id, studienbeitragsstatus"],
		blocked: [
			{ what: "TUMonline web session (exam registration pages)", why: "no automated TUMonline web login (removed in 0.7.0); exam dates come from the public exam list, my exams from pruefungenEigene, rooms from kalender" },
			{ what: "exam and course registration or deregistration", why: "left out on purpose: read only" },
		],
	},
	{
		platform: "moodle (SSO session)",
		works: [
			"AJAX: courses, upcoming deadlines, discussion posts, forum reply, messages, notifications, course index",
			"web pages: course contents, file downloads, forums, discussions, announcements, assignments and status, quizzes and attempts, grades, any page (moodle_page)",
			"web forms: new forum post, assignment text and file submission",
			"iCal export: deadlines and events without login",
		],
		blocked: [
			{ what: "web service token (MOODLE_TOKEN)", why: "TUM issues no tokens, the mobile web service is off" },
			{ what: "RSS feeds", why: "switched off for the course forums" },
			{ what: "16 AJAX functions (contents, forums, assign, quiz, grades, calendar ranges)", why: "not enabled for AJAX by TUM; the web page tools replace them" },
			{ what: "quiz attempts (start, answer)", why: "not built: a quiz attempt is graded work, start it in the browser" },
		],
	},
	{
		platform: "artemis",
		works: [
			"courses, exercises, results and feedback, lectures and files, exams (read only), channels and messages, notifications",
			"start participation, text and modeling submissions",
			"programming: repository files, read, write, commit, build results, trigger build",
			"course quizzes: read, submit live (synchronized and individual) and practice",
		],
		blocked: [
			{ what: "exam participation and submission", why: "left out on purpose (exam rules)" },
			{ what: "quizzes in batched mode", why: "need the batch password from the lecturer; join in the web app" },
			{ what: "file upload exercises", why: "not built yet" },
		],
	},
	{
		platform: "tumlive",
		works: ["my courses, streams, new recordings, stream details with HLS and download links, live now"],
		blocked: [{ what: "chat, bookmarks, watch progress", why: "not built yet" }],
	},
	{
		platform: "its scoreboard",
		works: ["full scoreboard, my team rank by score", "any page read only (its_scoreboard_page), one task page (its_scoreboard_task), my team or registration state (its_scoreboard_team)", "collector: every page and file linked from the scoreboard"],
		blocked: [{ what: "submissions, team registration, joining, booking, SSH keys, tutorial attendance", why: "left out on purpose: read only, action links are refused" }],
	},
	{
		platform: "collector 0.7 (pure collector, no interpretation)",
		works: [
			"collector_run: reads all sources, stores the last state per item (D1 tum-mcp, R2 tum-files), returns new, changed (with old and new value per field) and removed items with source and link",
			"collector_ack: confirms processed deltas (moves the delivered pointer; collector_run never moves it)",
			"collector_item: full stored content of an item or a delta, stored HTML of web pages, stored files",
			"cron every 30 minutes, one invocation per unit (Workers Free plan); large first reads go on run by run",
			"files in R2 up to 100 MB with link and R2 key, no text made from files; videos only as link",
			"scope: mail and Zulip from 15 September 2026; Moodle courses from config/moodle-courses.json (ids and name texts); Artemis and TUM-Live only courses of the current semester (see docs/TECH.md)",
			"mails over 25 MB: read part by part over several invocations (unit mail-large)",
		],
		blocked: [
			{ what: "rules, plans, names, deadlines, decisions", why: "left out on purpose: the watcher chat applies the owner's rules; the worker only collects" },
			{ what: "Artemis channel messages", why: "reading a channel marks it as read in Artemis; notifications carry the posts" },
			{ what: "videos and files over 100 MB", why: "left out on purpose: only the link is kept" },
			{ what: "Moodle viewed and completion marks", why: "the collector opens activity pages, so Moodle sets them; accepted by the owner" },
		],
	},
];

/** Tools that are new in this server version (server_info lists them). */
export const NEW_IN_VERSION = {
	version: "0.10.0",
	tools: [],
	removed: [
		"watcher_run, watcher_status, watcher_neu, watcher_dringend, watcher_digest",
		"queue_list, queue_add, queue_delete, queue_mark_done, queue_skip",
		"sync_plan, sync_report, sync_status_report, sync_inventory_report",
		"calendar_plan, calendar_report, calendar_decide, calendar_inventory_report",
		"course_state, course_alias_set, course_folders_set, course_ignore, course_unignore, course_projects_set, course_project_decide",
		"change_decide, duplicate_decide, deadline_add, deadline_ignore, deadline_link, deadlines_list",
		"files_pending, files_get, files_mark_saved",
		"tumonline_web_my_exams, tumonline_web_exam_offers, tumonline_web_my_courses, tumonline_browser_status",
	],
	changed: [
		"0.10.0: large files streamed into R2 (up to 100 MB); collector_item gives files over 4 MB as signed download links (download_link); external course websites from config/external-sites.json (also sites that unlock their links with an access token)",
		"0.9.0: collector_ack (collector_run no longer moves the delivered pointer: at-least-once delivery); Moodle sections of courses with one section per page; label text without HTML attributes",
		"0.8.2: scoreboard downloads named by the text of their link (the server sends no file name)",
		"0.8.1: scoreboard team page without the one-time team code in the item content",
		"0.8.0: ITS scoreboard read completely (every page and file linked from the scoreboard, read only); tools its_scoreboard_page, its_scoreboard_task, its_scoreboard_team",
		"0.7.6: Moodle courses from config/moodle-courses.json; PDF text conversion (Workers AI) and all stored PDF texts removed",
		"0.7.5: Moodle folder files and forum discussions are read before the activity page rotation, so they no longer stay pending",
		"0.7.4: pending markers and unit rows of courses outside the scope are removed, so not_read_yet lists only work inside the scope",
		"0.7.3: Moodle courses by Moodle's classification (in progress and future) instead of the start date",
		"0.7.2: Moodle read completely again (activity pages, course page, grade report); scope: mail and Zulip from 15 September 2026, Moodle, Artemis and TUM-Live only current-semester courses; items outside the scope are forgotten without a delta",
		"0.7.1: Moodle read without view logs; mails over 25 MB read completely (unit mail-large); public exam list matched by course id, number and German or English name; one-time wipe code removed",
		"0.7.0: the worker is a pure collector; D1 tum-mcp and R2 tum-files were wiped once; no TUMonline web login, no Browser Rendering",
	],
};
