# Technical notes (state on 22 October 2026)

## TUM connector

- Cloudflare Worker at `https://tum-mcp.<your-subdomain>.workers.dev/mcp`.
- Version on `main`: 0.10.0 (22 October 2026).
- History:
  - 0.6.9 to 0.6.20 built a TUMonline web login. From 0.6.17 it used Browser Rendering.
  - 0.6.21 added the public exam list.
  - 0.7.0 made the worker a pure collector. It removed the TUMonline web login, Browser Rendering and all tools that interpret, plan or decide.
  - 0.7.1 reads Moodle without logging views, reads mails over 25 MB completely, matches the public exam list also by course name, and removed the one-time wipe code.
  - 0.7.2 reads Moodle completely again (activity pages, course page, grade report) and limits the scope: mail and Zulip from 15 September 2026, Moodle, Artemis and TUM-Live only courses of the current semester.
  - 0.7.3 takes the Moodle courses from Moodle's own classification (in progress and future) instead of the start date.
  - 0.7.4 removes the pending markers and unit rows of courses outside the scope.
  - 0.7.5 reads the folder files and forum discussions of a Moodle course before the activity pages that are due for a re-read, so they finish.
  - 0.7.6 takes the Moodle courses from `config/moodle-courses.json` and removes the PDF text conversion (Workers AI) with all stored PDF texts.
  - 0.8.0 reads every page and file of the ITS scoreboard, and adds the read-only tools `its_scoreboard_page`, `its_scoreboard_task` and `its_scoreboard_team`.
  - 0.8.1 blanks the one-time team code of the scoreboard team page.
  - 0.9.0 adds `collector_ack` (at-least-once delivery, `collector_run` no longer moves the delivered pointer), reads the sections of Moodle courses that show one section per page, and gives labels their text without HTML attributes.
  - 0.10.0 streams large files into R2 (up to 100 MB), gives files over 4 MB in `collector_item` as signed download links, and reads the external course websites in `config/external-sites.json` (also sites that unlock their links with an access token).
  - 0.8.2 names scoreboard downloads (`/tasks/<n>/dl`, sent without a file name) by the text of their link, for example `t04.zip`.
- Deploy through Workers Builds from the branch `main`.
- Login through a GitHub OAuth app. Only the account in the secret `ALLOWED_GITHUB_LOGIN` can log in.

## Storage

All on the Cloudflare Free plan.

| Binding | Resource | Use |
| --- | --- | --- |
| `OAUTH_KV` | KV | OAuth clients, grants and tokens |
| `CACHE` | KV | Platform tokens and login sessions (TUMonline token, Artemis JWT, Moodle and TUM-Live sessions) |
| `DB` | D1 `tum-mcp` | Collector state per item and the delta log |
| `FILES` | R2 `tum-files` | Web page HTML, files, contents over 400 kB and large mails in progress |
| `COLLECTOR` | Service binding to this Worker (entrypoint `CollectorRunner`) | One invocation per collector unit |

## Secrets

Only the names are listed here. The operator sets the values (see `.env.example`).

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `ALLOWED_GITHUB_LOGIN`
- `COOKIE_ENCRYPTION_KEY`
- `TUM_USER`
- `TUM_PASSWORD`
- `TUM_EMAIL`
- `TUM_DISPLAY_NAME`
- `ZULIP_EMAIL`
- `ZULIP_API_KEY`
- `MOODLE_CALENDAR_URL`
- `MOODLE_RSS_TOKEN` (has no use)
- `ITS_SCOREBOARD_NAME` (placeholder)

## Client note

A chat that is already open does not see new tools after a connector update. Start a new chat.

## Collector

The requirements are in [REQUIREMENTS.md](REQUIREMENTS.md). This section describes how the code meets them.

### Runs

- The cron `*/30 * * * *` and the tool `collector_run` start a run.
- A run calls one unit per invocation through the service binding `COLLECTOR`. Each unit then has its own Free plan budget (50 external subrequests, 10 ms CPU).
- The units are `maintenance`, `mail`, `mail-large`, `zulip`, `tumonline`, `tumonline-courses`, `tumonline-exams`, `artemis`, `artemis-course:<id>`, `moodle`, `moodle-course:<id>`, `tumlive`, `its_scoreboard` and `site:<id>` (one per external course website).
- A request can make at most 32 invocations. The course units of Moodle and Artemis share the rest of this limit. The least recently run course goes first.
- `collector_run` starts units for 30 seconds and waits at most 50 seconds. Units that are still running finish in the background. Their deltas come with the next call.

### Delivery (at least once)

- The state row `delivered` holds the id of the last confirmed delta.
- `collector_run` returns the deltas with an id above `after` (default: `delivered`), in pages of at most `max_chars`, with `next_after` and `more`. It never changes `delivered`.
- `collector_ack(next)` sets `delivered` to `next`. `next` must be the current pointer or the id of an existing delta above it. The update runs only while the stored pointer is not above `next`, so the pointer never moves backwards, also when two calls race. The result has the old and the new pointer.
- The caller pages with `after = next_after` until `more` is false, processes the deltas, saves its results and then calls `collector_ack` with the last `next_after`. A call that breaks off before the ack gets the same deltas again.
- Confirmed deltas stay 30 days, then they are deleted.

### Listings, versions and rotation

- Each unit makes listings (scopes). A listing has one entry per item.
- An entry can carry a version mark (`sig`), for example a mail UID, a Moodle file revision or the Artemis exercise overview. An entry with an unchanged mark is not read again.
- An entry without a version mark (for example a Moodle activity page) is read again in rotation. The oldest read goes first. A change on such a page is therefore seen when its turn comes.
- Each unit has a load limit per invocation. New entries go first. In a Moodle course the listings of folder files and forum discussions are applied before the activity pages, because the re-reads of the activity pages would otherwise use the whole load limit in every run.
- A load that runs out of budget halfway (a discussion with many attachments) stays pending. The files it stored are kept under their revision key and are not read again, so the next run goes on where this one stopped. Entries that did not fit stay pending and appear under `not_read_yet` in `collector_run`.
- A complete listing reports stored items that are missing as removed. Some listings cover only a range (`windowFrom`), for example the TUMonline calendar, the public exam list, the Moodle calendar export and the newest 500 Zulip messages. Items before the start of that range are never reported as removed.

### Change check

- Each item has a hash of its title, link and content. The raw HTML is not part of the hash.
- A changed item gets one delta row with the complete new content and a list of changed fields with the old and the new value.
- For long texts the change list shows only the changed lines and their line numbers.
- Values that change on every read without any change on the platform are left out before the check:
  - the Moodle session key in links
  - the Moodle countdown "Verbleibende Zeit" (time remaining)
  - the read state of mails, Zulip messages, Moodle notifications and conversations
  - Moodle course progress and favourite mark
  - TUM-Live viewer counts and live state

### Scope

The rules are in `src/collector/scope.ts`.

- Mail: `UID SEARCH SINCE 15-Sep-2026` in every folder (the server's internal date). Older mails are not read.
- Zulip: messages with a timestamp from 15 September 2026, 00:00 Berlin time. The history read stops at that date.
- Moodle: the courses in `config/moodle-courses.json`. A course is in scope when its Moodle id is in `course_ids`, or when its full or short name contains one of the texts in `name_contains` (case ignored). So a course comes in by itself once you are enrolled in it. To change the list, edit the file and push to `main`.
- Artemis: courses whose `semester` field is the current semester (for example `WS26/27`). Without that field, the course start must lie in the current semester or up to 45 days before it. The TUM semester is computed from the date (winter 1 October to 31 March, summer 1 April to 30 September).
- TUM-Live: the enrolled courses of the semester that TUM-Live marks as current.

Items outside the scope are forgotten: the item and its deltas that `collector_run` has not returned yet are deleted. They never appear in the output, neither as new nor as removed. A stored mail that is deleted on the server is forgotten when its date is before the limit, and reported as removed otherwise.

The bookkeeping of a course outside the scope is removed too: its pending markers (course, timeline, folder and forum listings) and its row in `unit_runs`. So `not_read_yet` in `collector_run` lists only work inside the scope. The units `moodle` and `artemis` do this on every run.

### ITS scoreboard

The unit `its_scoreboard` logs in with TUM SSO (session cookie in KV `CACHE` for 12 hours) and reads `scoreboard.sec.in.tum.de`:

- The menu (seen on 22 October 2026) has `/scoreboard`, `/tasks`, `/materialien`, `/booking`, `/tutorials/attend`, `/team`, `/sshkeys` and `/logout`.
- The listing is `/scoreboard` plus every link on the host found on the pages read so far. Pages read in a run can add new links in the same run (up to 4 rounds), so task pages and their files come in from the first run on. A page that is no longer linked shows up as removed.
- A page (HTML) becomes an item with its full text, links, dates and the raw HTML in R2. A file (any other content type) goes to R2 like a Moodle file, without text. Page assets (CSS, JavaScript, fonts) are skipped. At most 300 URLs are read.
- Pages have no version mark, so they are read again in rotation, 20 per invocation.
- The key of the scoreboard table stays `its_scoreboard:page`. Other items have the key `its_scoreboard:url:<path>`.
- The team page shows a one-time code to form a team (valid for 60 minutes). It is new on every read and lets another student join, so it is blanked in the item content. The HTML in R2 keeps the page as served.
- Pages found on 22 October 2026: `/scoreboard`, `/tasks`, the task pages `/tasks/1` to `/tasks/8` with their downloads `/tasks/<n>/dl`, `/materialien` (empty so far), `/booking`, `/tutorials/attend`, `/team` and `/sshkeys`. Not read: `/logout` and `/sshkeys/add` (action links), and the forms to submit a solution, form a team or book a slot.

Read only: every request is a GET, no form is sent, and `safeScoreboardUrl` refuses any path segment or query parameter with an action word (logout, join, leave, register, submit, book, delete, add, edit, start and others) and any link with a token. The same check guards the tools `its_scoreboard_page`, `its_scoreboard_task` and `its_scoreboard_team`. Redirects are checked the same way.

### External course websites

The sites are in `config/external-sites.json`. Each site has an `id`, a `name`, the Moodle course it belongs to, its `start` pages and its `follow` prefixes. To add a site, add an entry and push to `main`. A site that is removed from the file is forgotten on the next run (items and undelivered deltas, without "removed" deltas).

- One unit `site:<id>` per site, one invocation each, in the group without TUM SSO. It sends only GET and HEAD requests.
- The listing is the start pages plus every link on the pages read so far whose URL starts with a `follow` prefix. Links in HTML comments are not followed (the browser does not show them). Assets (CSS, JavaScript, fonts) and videos are skipped. At most 300 URLs, up to 4 rounds per run, 15 loads per invocation. Pages are read again in rotation.
- A page (HTML) becomes an item `site:<id>:<url>` with its full text, links, dates, tables and the raw HTML in R2.
- A file is read with HEAD first. A file with the same length, ETag and Last-Modified as before is taken from R2 and not downloaded again.

The list in this repository is empty. Add your own sites.

Some course sites make no data request and keep the schedule and the materials in `index.html`, with the lecture links encrypted in the page with CryptoJS AES (OpenSSL format `Salted__`, key and IV from EVP_BytesToKey with MD5, AES-256-CBC). The passphrase is the access token from the URL fragment. For a site with an `unlock` entry, the unit:

1. reads the token from the stored items whose content contains the configured text (`token_in_items_like`), for example a Moodle announcement or a mail,
2. checks the token with the page's own check value, which must decrypt to `magic`,
3. decrypts the links of every table row and stores them under `unlocked` with the cells of the row (day, date, time, name, event, material).

The token is in no code, no doc and no stored item of the site. A decrypted link that contains the token (the pad link) gets `[access token]` in its place. Without a valid token, `unlocked` says so. The decryption is in `src/lib/cryptojs-aes.ts` (WebCrypto has no MD5, so MD5 is implemented there).

### Large files and download links

- `storeResponse` reads a file into memory only when its size is known and at most 8 MB. A larger file, or a file without `Content-Length`, is streamed into R2 with a multipart upload of 8 MiB parts (`streamToR2`). The upload stops and is aborted above 100 MB, then only the link is kept.
- A tool result carries a file as base64, so files over about 10 MB could not be handed out before 0.10.0. They were stored already (for example a lecture PDF of 56,539,312 bytes).
- `collector_item` with `r2_key` returns a file up to 4 MB in the result. A larger file comes as a link `https://tum-mcp.<your-subdomain>.workers.dev/files/download?k=<R2 key>&e=<expiry>&s=<signature>`. The signature is an HMAC-SHA256 over key and expiry with a key derived from `COOKIE_ENCRYPTION_KEY`. A link is valid for one hour and only for keys under `files/`, `html/` and `content/`. The route streams the object from R2.
- The origin of the links is the variable `PUBLIC_ORIGIN` in `wrangler.jsonc`.

### Moodle

Courses can show one section per page (Moodle course format setting). Their course page shows section 0 only. The unit finds the sections that the course page does not show (no block `section-N`, or activities missing from the page) and reads each such section page (`course/view.php?id=<course>&section=<n>`) as an item `moodle:section:<section id>` in the listing `moodle:sections:<course>`, with the section summary and everything on that page. Labels in these sections take their text from their section page. At most 4 section pages are read per run (rotation), so new activities of the course still get loads.

The course unit opens the course page, every activity page (`mod/<type>/view.php`), the resource files, the folder pages and files, the forum pages and the grade report. This sets Moodle's "viewed" and completion marks. The owner accepted this. Each forum discussion is read with all posts through `mod_forum_get_discussion_posts`. Discussions named in Moodle notifications are read the same way.

### Mails over 25 MB

A mail over 25 MB does not fit one invocation. Workers have 128 MB memory, and the Free plan allows 10 ms CPU per invocation. The unit `mail-large` therefore reads such a mail over several invocations:

1. It reads the structure (`BODYSTRUCTURE`) and the header.
2. It reads small parts (up to 5 MB) one by one and parses them with postal-mime.
3. It reads large parts with IMAP partial fetches of 6 MB, decodes them (base64 or quoted-printable) and writes them to R2 as parts of a multipart upload.
4. R2 needs all parts except the last to have the same size (5 MiB). Decoded bytes that do not fill a part wait in R2 (`mailbig/`) for the next invocation.
5. When all parts are read, the result goes to R2 (`mailbig/<key>/done.json`) and the unit `mail` reports the mail like any other mail.

Videos and attachments over 100 MB are not stored, only listed with their size. A mail that fails 5 times is reported with the error instead of its body.

### Public exam list

The unit `tumonline-exams` keeps an exam entry when one of these is true:

- Its course id is a course id from `veranstaltungenEigene`, the calendar or `pruefungenEigene`.
- Its course number is a number from `pruefungenEigene` or the public course data.
- One of its course names (German or English) is equal to a title from `veranstaltungenEigene`, `pruefungenEigene` or the public course data (`courses/{id}`, all languages).

Names are compared after trimming, joining white space and ignoring case. There is no partial or similar match.

### Tables in D1 `tum-mcp`

| Table | Content |
| --- | --- |
| `items` | Last state per item: key, source, scope, title, link, version mark, hash, content, HTML key, first seen, last change, last read, present or removed |
| `deltas` | One row per new, changed or removed item, with the content at that moment and the change list |
| `state` | Cursors and lists between runs, the delivered delta id, written rows per day, the large mail queue, the result of the 0.7.0 wipe |
| `unit_runs` | Last run per unit: state, message, counts, subrequests |

The tables are created in code on first use. There are no migration files.

### R2 `tum-files`

| Prefix | Content |
| --- | --- |
| `html/` | Raw HTML of web pages and HTML mail bodies |
| `files/` | Attachments, course files and website files (large files streamed in parts) |
| `content/` | Item contents larger than 400 kB |
| `mailbig/` | Large mails in progress and finished large mails |
| `_epoch/` | Marker of the 0.7.0 wipe. Since 0.7.1 no code reads it. |

### Limits

- D1 Free plan allows 100,000 written rows per day. The collector stops reading new entries at 80,000 rows on a UTC day and goes on the next day.
- Delivered deltas are deleted 30 days after detection.
- The collector makes no text from files. The watcher reads every PDF itself.
- Artemis channel messages are not read. Reading a channel marks it as read in Artemis. The Artemis notifications carry the posts.
- The first run takes several cron runs for many mails and big Moodle courses.

### One-time wipe in 0.7.0

The first request after the 0.7.0 deploy dropped every table in D1 `tum-mcp` and deleted every object in R2 `tum-files`. The result is in the `state` row `wipe:0.7.0`. Version 0.7.1 removed the wipe code. The worker now only creates missing tables and never drops or deletes data, also when the R2 marker is gone.

### PDF text clean-up in 0.7.6

0.7.0 to 0.7.5 stored a PDF text made by Workers AI next to each PDF (`.txt` in R2) and in the file entries (`text`, `text_error`). The unit `maintenance` removes them once, before any other unit of a run reads items:

1. It deletes the `.txt` objects under `files/` in R2.
2. It removes `text` and `text_error` from the file entries of stored items and computes their hash again, so no delta is created.
3. It does the same in the deltas that `collector_run` has not returned yet, also in their change lists.

The state row `maintenance:pdftext:done` records the end. After that the unit does nothing.
