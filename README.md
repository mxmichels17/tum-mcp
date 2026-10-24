# TUM MCP

A remote MCP server on Cloudflare Workers. It connects Claude (claude.ai custom connector) to TUM platforms.

It gives Claude tools for TUM mail, Zulip, TUMonline, Moodle, Artemis, TUM-Live and the ITS scoreboard. A collector reads these sources every 30 minutes and returns what is new, changed or removed since the last call.

## Quick start

```sh
npm install
cp .env.example .env             # fill in your own values, never commit this file
npm test
npm run dev                      # http://localhost:8788/mcp
```

All credentials come from environment variables (`.env` or `.dev.vars` locally, Worker secrets in production). `.env.example` lists every name. The full setup is in [Cloudflare setup](#cloudflare-setup).

This version (0.10.0) has these tool groups:

| Prefix | Platform | Login |
| --- | --- | --- |
| `mail_` | TUM mail through LRZ: IMAP `xmail.mwn.de:993` (TLS), SMTP `postout.lrz.de:587` (STARTTLS) | LRZ ID and password |
| `zulip_` | Zulip `zulip.cit.tum.de` | Zulip API key |
| `tumonline_` (public) | Public TUMonline course data (`campus.tum.de/tumonline/ee/rest`) | none |
| `tumonline_` (personal) | TUMonline web service `wbservicesbasic` (grades, calendar, own courses, persons, fees) | TUMonline token (KV or `TUMONLINE_TOKEN`) |
| `moodle_` | TUM Moodle `www.moodle.tum.de` web service functions | TUM SSO session with LRZ ID and password (TUM issues no web service tokens) |
| `moodle_` (feeds) | Moodle iCal export and forum RSS feeds | export link and RSS key, no login |
| `artemis_` | Artemis `artemis.tum.de` | LRZ ID and password (LDAP), JWT cached in KV |
| `tumlive_` | TUM-Live `live.rbg.tum.de` (API v2) | TUM SSO with LRZ ID and password, session cached in KV |
| `public_its_scoreboard`, `its_scoreboard_` | ITS scoreboard `scoreboard.sec.in.tum.de` | TUM SSO (the scoreboard is not public) |
| `collector_` | Pure collector. It reads every source, stores the last state per item in D1 and R2, returns the exact delta since the last call. No interpretation ([docs/REQUIREMENTS.md](docs/REQUIREMENTS.md), [docs/TECH.md](docs/TECH.md)) | uses the above |
| `status`, `server_info` | Connection check for every platform; server version and registered tools | uses the above |

The owner's rules (what to do with new items) are not in this repository. A separate Claude chat (the watcher) applies them to the output of `collector_run`. The technical requirements are in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md), the setup in [docs/TECH.md](docs/TECH.md).

## Tools

| Tool | What it does | Writes |
| --- | --- | --- |
| `status` | Tests each platform. Result per platform: OK, not configured, login error, token not activated, error, not implemented. | no |
| `mail_folders` | Lists folders with special use (Sent, Trash) and optional counts. | no |
| `mail_search` | Searches a folder (from, to, subject, text, date range, unread, flagged). Newest first. | no |
| `mail_read` | Reads one message: headers, text body, attachment list. | only with `mark_as_read` |
| `mail_download_attachment` | Gets one attachment. Images as image, text as text, other files as base64 resource. | no |
| `mail_send` | Sends a new mail, with attachments. Saves a copy in Sent. | yes, needs a yes |
| `mail_reply` | Replies (optionally to all) with threading headers and quote. Flags the original as answered. | yes, needs a yes |
| `mail_forward` | Forwards inline with the original attachments. | yes, needs a yes |
| `mail_move` | Moves messages to another folder. | yes |
| `mail_flags` | Sets or removes seen, flagged, answered, draft or keywords. | yes |
| `mail_trash` | Moves messages to Trash. Nothing is deleted permanently. | yes, needs a yes |
| `zulip_get_messages` | Gets messages with narrow filters (channel, topic, sender, DM, search, is). | no |
| `zulip_get_message` | Gets one message by ID. | no |
| `zulip_list_channels` | Lists subscribed or all channels. | no |
| `zulip_get_topics` | Lists the topics of a channel. | no |
| `zulip_send_channel_message` | Posts to a channel topic. | yes, needs a yes |
| `zulip_send_dm` | Sends a direct message. | yes, needs a yes |
| `zulip_add_reaction`, `zulip_remove_reaction` | Adds or removes an emoji reaction. | yes, needs a yes |
| `zulip_upload_file` | Uploads a file and returns its URL. | yes, needs a yes |
| `zulip_subscribe` | Subscribes to channels. | yes, needs a yes |
| `tumonline_semesters` | Lists semesters (ID and key, for example 26W). | no |
| `tumonline_course_search` | Searches the course catalogue by title or number. | no |
| `tumonline_course_details` | Gets course details: lecturers, SWS, language, description, links. | no |
| `tumonline_course_groups` | Gets the course groups with weekly series. | no |
| `tumonline_course_dates` | Gets the single dates with time and room. | no |
| `tumonline_request_token` | Requests a TUMonline token for `TUM_USER` and stores it in KV. The token is never shown. | yes, needs a yes |
| `tumonline_token_status` | Checks if the token is activated. | no |
| `tumonline_identity` | Name, TUM ID, obfuscated IDs. | no |
| `tumonline_grades` | Exam results. | no |
| `tumonline_token_raw` | Raw data of one read-only token function (allowlist: kalender, noten, pruefungenEigene, veranstaltungenEigene, veranstaltungenDetails, veranstaltungenTermine, absNoten, id, studienbeitragsstatus). | no |
| `tumonline_calendar` | Personal calendar in a date range. | no |
| `tumonline_my_courses` | Own registered courses. | no |
| `tumonline_my_course_details` | Details and dates of a course by LV number. | no |
| `tumonline_person_search`, `tumonline_person_details` | Find TUM persons, get contact details. | no |
| `tumonline_fee_status` | Tuition fee status. | no |
| `tumonline_public_exams` | Public TUMonline exam dates, no login: exam date and time, registration start and end, deregistration end, raw entries. Optional course numbers (module number or course id); the tool reads all pages and filters. | no |
| `moodle_site_info` | Session mode: user ID and the probe result. Token mode: the allowed web service functions. | no |
| `moodle_page` | Any Moodle page through the session as text with links, or raw HTML. Fallback for everything else. | no |
| `moodle_probe` | Calls the Moodle function behind each tool once and reports allowed or not allowed. Write functions get empty arguments, which Moodle rejects before it does anything. | no |
| `moodle_calendar_ics` | Events and deadlines from the iCal export (`MOODLE_CALENDAR_URL`). No login. | no |
| `moodle_rss_discover` | Finds the forum RSS feeds of the current courses through the SSO session once and stores them in KV. | stores feed list |
| `moodle_forum_rss` | Latest forum and announcement posts from the stored feeds (`MOODLE_RSS_TOKEN`). No login. | no |
| `moodle_courses`, `moodle_course_contents` | Courses, sections, activities, file URLs. | no |
| `moodle_download_file` | Downloads a Moodle file (only from www.moodle.tum.de). | no |
| `moodle_forums`, `moodle_announcements`, `moodle_forum_discussions`, `moodle_discussion_posts` | Read forums and announcements. | no |
| `moodle_forum_post`, `moodle_forum_reply` | New discussion, reply. | yes, needs a yes |
| `moodle_assignments`, `moodle_assignment_status` | Assignments with due dates, submission and grading status, feedback. | no |
| `moodle_assignment_submit_text`, `moodle_assignment_submit_file` | Save a text or file submission, optionally submit for grading. File upload needs `MOODLE_TOKEN`. | yes, needs a yes |
| `moodle_quizzes`, `moodle_quiz_attempts`, `moodle_quiz_attempt_review` | Quizzes, my attempts, attempt results. | no |
| `moodle_grades_overview`, `moodle_course_grades` | Grades overview and grade items per course. | no |
| `moodle_calendar_events`, `moodle_upcoming_deadlines` | Calendar in a range, deadlines in the next N days. `moodle_upcoming_deadlines` uses the iCal export when the session fails. | no |
| `moodle_conversations`, `moodle_conversation_messages`, `moodle_search_users` | Read messages, find users. | no |
| `moodle_send_message` | Sends a private message. | yes, needs a yes |
| `moodle_notifications` | Latest notifications. | no |
| `artemis_courses` | Courses with my total score and active exams. | no |
| `artemis_exercises`, `artemis_exercise_details` | Exercises with due dates, my submission and result, problem statement. | no |
| `artemis_result_feedback` | Test cases and feedback of a result. | no |
| `artemis_lectures`, `artemis_lecture_details`, `artemis_download_attachment` | Lectures, units, lecture files. | no |
| `artemis_exams` | Exams of a course. | no |
| `artemis_channels`, `artemis_messages` | Channels and messages (reading marks the channel as read). | no |
| `artemis_post_message`, `artemis_reply_message` | Posts a message or a thread reply. | yes, needs a yes |
| `artemis_notifications` | Course notifications. | no |
| `tumlive_my_courses`, `tumlive_course_streams` | My courses, streams and recordings of a course. | no |
| `tumlive_new_recordings` | New recordings since a date. | no |
| `tumlive_stream` | Watch link, HLS playlists, download links, attachments. Signed URLs expire after about 7 hours. | no |
| `tumlive_live_now` | Courses that stream live now. | no |
| `public_its_scoreboard` | All teams with their columns and `rank_by_score`. | no |
| `public_its_scoreboard_me` | My team's entry and rank (`ITS_SCOREBOARD_NAME` = team name). Without a match: the columns and the 5 closest names. | no |
| `its_scoreboard_page` | One scoreboard page as shown when logged in: title, text, links, dates, tables. Action links (logout, join, register, submit, book, delete) are refused. | no |
| `its_scoreboard_task` | One task page, by path or by a text of its link on `/tasks`. | no |
| `its_scoreboard_team` | My team page (`/team`): team and members, or the registration state. | no |
| `server_info` | Server version, deployed Worker version, all tools of this session, and per platform what works and what is blocked (and why). | no |
| `mail_create_folder`, `mail_rename_folder` | Create, rename or move a folder (special folders are refused). | yes |
| `mail_delete_folder` | Delete a folder, only if it is empty and has no subfolders. | yes, needs a yes |
| `mail_save_draft` | Save a mail in Drafts (nothing is sent). | yes |
| `zulip_edit_message`, `zulip_delete_message` | Edit or delete one of my own messages. | yes, needs a yes |
| `zulip_mark_read` | Mark messages, a topic or a channel as read. | yes |
| `zulip_users`, `zulip_user` | Find users, user details. | no |
| `zulip_subscriptions`, `zulip_set_subscription` | My subscriptions; mute, unmute, pin. | `zulip_set_subscription` changes settings |
| `zulip_unsubscribe` | Unsubscribe from channels. | yes, needs a yes |
| `artemis_start_participation` | Start an exercise (creates the participation and, for programming, the repository). | yes, needs a yes |
| `artemis_text_get`, `artemis_text_submit` | Read and save my text. Every save before the due date counts as submitted. | submit needs a yes |
| `artemis_modeling_get`, `artemis_modeling_submit` | Read and save my model (Apollon JSON). | submit needs a yes |
| `artemis_repo_files`, `artemis_repo_read_file` | Files of my programming repository. | no |
| `artemis_repo_write_files`, `artemis_repo_commit`, `artemis_trigger_build` | Write files, commit (starts a build, counts as submission), build again. | yes, needs a yes |
| `artemis_build_result` | Latest build and test result, build logs. | no |
| `artemis_quiz_get`, `artemis_quiz_submit` | Course quizzes: questions, submit live or practice. No exam quizzes. | submit needs a yes |
| `collector_run` | Reads all sources (or the ones named), stores the last state per item, and returns the deltas after the delivered pointer: new items with complete content, changed items with complete new content and each changed field (old and new value), removed items with their last known content. Pages with `after` and `next_after`. Never moves the pointer. | stores the state in D1 and R2 (no platform writes) |
| `collector_ack` | Confirms the deltas up to `next` (the last `next_after`) after they were processed: moves the delivered pointer forward, never backwards. | moves the pointer |
| `collector_item` | Full stored content of an item or of one delta, the stored HTML of a web page, or a stored file (`r2_key`). Files over 4 MB come as a signed download link, valid for one hour. | no |

"Needs a yes" means that the tool description contains the sentence "Call only after the user said yes." This applies to every tool that sends, posts, submits, uploads, subscribes, reacts or moves mail to Trash. `mail_move` and `mail_flags` change only your own mailbox and are reversible, so they do not have the sentence.

## Security

- Login to the MCP server is OAuth 2.1 through [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) with GitHub as the identity provider.
- Only the GitHub account in the secret `ALLOWED_GITHUB_LOGIN` can log in. Without this secret nobody can log in. The check is in `src/auth/github.ts`. The MCP agent checks it again before it registers tools.
- The server does not keep the GitHub token.
- All credentials are Worker secrets. No credential is in the code or in git. `.env`, `.dev.vars` and key files are in `.gitignore`. `.env.example` lists every name.

## Cloudflare setup

You need a Cloudflare account and admin access to this GitHub repository.

### 1. Connect the repository to Workers Builds

1. Open the Cloudflare dashboard. Go to **Workers & Pages** > **Create application**.
2. Select **GitHub** (in some dashboards: **Import a repository**). Authorize the Cloudflare GitHub app if Cloudflare asks for it.
3. Select your copy of this repository.
4. Set these values:
   - Project name: `tum-mcp`. It must be the same as `name` in `wrangler.jsonc`, or the build fails.
   - Production branch: `main`.
   - Build command: empty.
   - Deploy command: `npx wrangler deploy` (default).
   - Root directory: `/` (default).
5. Select **Save and Deploy**.

The first deploy creates these resources automatically, because `wrangler.jsonc` has the bindings without IDs ([automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)):

- KV namespace for binding `OAUTH_KV` (OAuth clients, grants, tokens).
- KV namespace for binding `CACHE` (TUMonline token, Artemis JWT, Moodle and TUM-Live sessions). Values are encrypted with AES-GCM when `COOKIE_ENCRYPTION_KEY` is set.
- D1 database `tum-mcp` for binding `DB` (collector state and delta log, tables created in code).
- Durable Object class `TumMCP` (one MCP session per connection).
- Cron trigger `*/30 * * * *` (runs the collector).
- R2 bucket `tum-files` for binding `FILES` (collector HTML, files and large contents).

Every push to `main` deploys again.

Note your Worker URL. It looks like `https://tum-mcp.<your-subdomain>.workers.dev`. The examples below use `https://tum-mcp.example.workers.dev`.

Set `PUBLIC_ORIGIN` in `wrangler.jsonc` (`vars`) to this URL. Replace the placeholder `YOUR_SUBDOMAIN`. The signed download links of `collector_item` use it.

Set the scope of the collector in `config/moodle-courses.json` (Moodle course ids or name texts) and `config/external-sites.json` (external course websites). Both lists are empty in this repository.

### 2. D1 and R2

No migrations. The collector creates its tables (`items`, `deltas`, `state`, `unit_runs`) on first use. Version 0.7.0 wiped D1 `tum-mcp` and R2 `tum-files` once. Version 0.7.1 removed the wipe code, so the worker never drops or deletes stored data.

If the automatic provisioning did not create the database, create it and bind it in the dashboard: **Storage & Databases** > **D1** > **Create** with the name `tum-mcp`. Then go to the Worker > **Settings** > **Bindings** > **Add** > **D1 database**, variable name `DB`.

### 3. GitHub OAuth app

1. On GitHub, go to **Settings** > **Developer settings** > **OAuth Apps** > **New OAuth App**.
2. Set these values:
   - Application name: `TUM MCP`.
   - Homepage URL: `https://tum-mcp.example.workers.dev`.
   - Authorization callback URL: `https://tum-mcp.example.workers.dev/callback`.
3. Select **Register application**.
4. Copy the **Client ID**. Select **Generate a new client secret** and copy the secret.

### 4. Secrets

Go to the Worker > **Settings** > **Variables and Secrets** > **Add**. Select type **Secret** for each value. Then select **Deploy**.

Alternative on your computer: `npx wrangler secret put <NAME>`.

| Secret | Required | Value |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | yes | Client ID of the GitHub OAuth app |
| `GITHUB_CLIENT_SECRET` | yes | Client secret of the GitHub OAuth app |
| `ALLOWED_GITHUB_LOGIN` | yes | Your GitHub user name. Only this account can log in. |
| `COOKIE_ENCRYPTION_KEY` | recommended | Random string, minimum 32 characters, for example from `openssl rand -hex 32`. Signs the "remembered consent" cookie. Without it, the consent page shows on every login. |
| `TUM_USER` | for mail | LRZ ID (TUM ID), for example `ab12cde` |
| `TUM_PASSWORD` | for mail | Password of the LRZ ID |
| `TUM_EMAIL` | for sending mail | Your sender address, for example `max.mustermann@tum.de` |
| `TUM_DISPLAY_NAME` | optional | Sender name, for example `Max Mustermann` |
| `ZULIP_EMAIL` | for Zulip | The email of your Zulip account (Zulip > Personal settings > Account & privacy) |
| `ZULIP_API_KEY` | for Zulip | Zulip > Personal settings > Account & privacy > API key > Manage your API key |
| `MOODLE_TOKEN` | not available at TUM | TUM issues no Moodle web service tokens. Leave it empty. The code still supports a token if TUM ever offers one. |
| `MOODLE_CALENDAR_URL` | recommended for Moodle | Moodle > Kalender > Exportieren: select all courses, events and deadlines, a long time range, then copy the calendar URL. |
| `MOODLE_RSS_TOKEN` | not useful | RSS is off on TUM Moodle. `moodle_forum_rss` still reads it, `status` no longer checks it. |
| `ITS_SCOREBOARD_NAME` | optional | Your **team** name exactly as the ITS scoreboard shows it (the scoreboard lists teams, not persons). |
| `TUMONLINE_TOKEN` | optional | TUMonline web service token. Overrides the token that `tumonline_request_token` stored in KV. |

Artemis and TUM-Live use `TUM_USER` and `TUM_PASSWORD`. They need no new secret.

A platform without its secrets shows "not configured" in `status`. The other platforms still work.

Secrets stay when Workers Builds deploys again. `wrangler deploy` does not delete secrets.

### 5. Platform tokens

**TUMonline personal data:**

1. In a chat, ask Claude to run `tumonline_request_token`. The server requests a token for `TUM_USER` and stores it in KV.
2. TUMonline sends an email. Open TUMonline (campus.tum.de) > Visitenkarte > Token-Management, or use the link in the email.
3. Activate the token "tum-mcp" and grant all rights.
4. Run `tumonline_token_status` or `status`.

**Moodle access:** TUM Moodle has the mobile web service turned off (`enablemobilewebservice = 0`), and the "Sicherheitsschlüssel" page shows only the RSS key. So there is no `MOODLE_TOKEN`. The tools use these sources:

- TUM SSO session (login.tum.de with `TUM_USER` and `TUM_PASSWORD`). The tools use a Moodle AJAX function where TUM allows it (courses, deadlines, discussion posts, replies, messages, notifications, course index). For everything TUM blocks, they read the normal Moodle web pages: course contents, forums and discussions, announcements, assignments and their status, quizzes and attempts, grades, file downloads. New forum posts and assignment submissions use the normal Moodle web forms. Tools that work on one activity take its `cmid` (course module ID) from `moodle_course_contents`, `moodle_assignments`, `moodle_quizzes` or `moodle_forums`.
- iCal export (`MOODLE_CALENDAR_URL`): deadlines and events without login. `moodle_upcoming_deadlines` falls back to it when the session fails.
- RSS (`MOODLE_RSS_TOKEN`): tested on 2026-10-17 with 10 forums. Every feed answered "Fehler beim Lesen der RSS-Daten", and no forum page showed an RSS link. RSS is switched off for these forums on TUM Moodle. `moodle_forum_rss` says so in its result. Use `moodle_announcements` (SSO session) for forum posts. `moodle_upcoming_deadlines` never used RSS.

The SSO login fails if your account needs a second factor at login.tum.de.

### 6. Collector

Nothing to set up. The cron `*/30 * * * *` and the tool `collector_run` read every source, store the last state per item in D1 `tum-mcp` and R2 `tum-files`, and write one delta row per new, changed or removed item. Details are in [docs/TECH.md](docs/TECH.md).

**Workers Free plan.** Each unit (one source, or one Moodle or Artemis course) runs in its own invocation through the service binding `COLLECTOR` (entrypoint `CollectorRunner`), so each unit has its own budget of 50 external subrequests and 10 ms CPU. A first read that does not fit (a large mailbox, the Zulip history, a big course) goes on run by run. `collector_run` lists what is not read yet.

### 7. Add the connector in claude.ai

1. Open claude.ai. Go to **Settings** > **Connectors**.
2. Select **Add custom connector**.
3. Name: `TUM`. URL: `https://tum-mcp.example.workers.dev/mcp`.
4. Leave the advanced OAuth fields (client ID, client secret) empty. Claude registers itself through the server (dynamic client registration or client ID metadata document).
5. Select **Add**, then **Connect**. A consent page from the Worker opens. Select **Allow**. Log in to GitHub with the account in `ALLOWED_GITHUB_LOGIN`.
6. In a chat, enable the connector and ask Claude to run the `status` tool.

**After a deploy that adds tools:** claude.ai keeps the tool list it loaded when it connected. In **Settings** > **Connectors**, disconnect the connector and connect it again (or remove and add it), then start a new chat. `server_info` lists every tool the server registers in the current session. If claude.ai shows fewer, its list is stale.

## Local development

```sh
npm install
cp .env.example .env             # fill in values, never commit this file
npm run dev                      # http://localhost:8788, MCP endpoint /mcp
npm test                         # unit tests (IMAP, SMTP, MIME, collector)
npm run type-check
```

For a local GitHub login, create a second GitHub OAuth app with the callback `http://localhost:8788/callback`. To test with the MCP Inspector, run `npx @modelcontextprotocol/inspector` and connect to `http://localhost:8788/mcp`.

After a change to `wrangler.jsonc` or to the secret names, run `npm run cf-typegen` with a `.env` that has all secret names. This updates `worker-configuration.d.ts`.

## Project layout

```
src/index.ts               OAuth provider, MCP agent (Durable Object), cron, collector entrypoint
src/auth/github.ts         consent page, GitHub login, account check
src/platforms/mail.ts      mail_ tools
src/platforms/zulip.ts     zulip_ tools
src/platforms/tumonline.ts tumonline_ tools (public)
src/platforms/tumonline-personal.ts tumonline_ tools (token, wbservicesbasic)
src/platforms/moodle.ts    moodle_ tools
src/platforms/artemis.ts   artemis_ tools
src/platforms/tumlive.ts   tumlive_ tools
src/platforms/status.ts    status tool
src/lib/tum-sso.ts         login through login.tum.de (SAML)
src/lib/http.ts            cookie jar, redirects, form parsing
src/lib/store.ts           encrypted state in the CACHE KV namespace
src/lib/xml.ts             minimal XML parser for TUMonline
src/lib/imap.ts            minimal IMAP client (RFC 3501)
src/lib/smtp.ts            minimal SMTP client with STARTTLS and AUTH PLAIN
src/lib/mime-build.ts      MIME message builder
src/lib/net.ts             cloudflare:sockets connect()
src/collector/             collector: model and change computation, web page text, files, store, runner, tools
src/collector/units/       collector units per source
test/                      unit tests (fake IMAP and SMTP servers, collector store on node:sqlite)
docs/REQUIREMENTS.md       what the collector must do technically
docs/TECH.md               setup, storage, secrets, limits
config/moodle-courses.json the Moodle courses the collector reads
config/external-sites.json the external course websites the collector reads
```

The IMAP and SMTP clients are written for this project because the common Node libraries need `net` and `tls` APIs. MIME parsing uses [`postal-mime`](https://github.com/postalsys/postal-mime), which runs on Workers.

## Test status

0.10.0: `npm test` (82 tests) and `npm run type-check` pass. The collector tests cover the change computation, the web page text and the D1 apply and wipe logic on an in-memory SQLite. The collector units were not run against the live platforms before the deploy.

Deployed and reported OK by the user: mail (IMAP, SMTP), Zulip, TUMonline public and personal (token active, 5 of 5 rights), Artemis, TUM-Live (SSO login works).

Tested in this build environment (0.3):

- Unit tests (`npm test`, 22 tests): iCal parser (folding, escapes, UTC and Europe/Berlin times, deadline detection), RSS parser and the Moodle error feed, forum ID detection, Moodle user ID detection, scoreboard table parsing and rank lookup, plus the earlier tests.
- The real `TumMCP` Durable Object in `wrangler dev`: a session created on the phase 1 code (26 tools) lists all 87 tools after the switch to the new code, and so does a new session. The server keeps no stale tool list.
- In `wrangler dev` against the live services with fake credentials: `status` reports every platform; the ITS scoreboard SSO login runs to "Username or password was incorrect"; the Moodle calendar export answers "Invalid authentication"; `moodle_upcoming_deadlines` reports both the session and the iCal error.
- Live checks without login: the scoreboard redirects to its TUM-ID login; the Moodle RSS URL format `rss/file.php/{contextid}/{token}/mod_forum/{forumid}/rss.xml` answers with an RSS error document for a wrong token.

**Not tested** (no valid credentials here):

- `moodle_probe` and every `moodle_` session tool with real data. Which functions TUM Moodle allows through AJAX.
- The Moodle user ID detection from the real pages, and the new status check (`core_course_get_enrolled_courses_by_timeline_classification`).
- `moodle_calendar_ics` with a real export link (the real event titles that mark deadlines).
- `moodle_rss_discover` (course page and forum page markup) and `moodle_forum_rss` with real feeds.
- Both ITS scoreboard tools: the page after login and its table layout were not visible. If the scoreboard is not an HTML table, the tool returns the page text in its error.
- That claude.ai shows all tools after a disconnect and connect.

Run `status` and `server_info` first after the deploy.

## Known limits

- One IMAP connection per tool call. Each call logs in again.
- Mail calls stop after 50 seconds, and the connect and login step after 15 seconds, because MCP clients stop waiting after about 60 seconds.
- Messages larger than 25 MB are not read. Attachments larger than 10 MB are not downloaded.
- `mail_forward` forwards inline. It does not attach the original as `message/rfc822`.
- The TUMonline endpoints are the REST API of the TUMonline web app. They are not officially documented and can change.
- Every Artemis password login sends a "new login" email. The JWT is cached for 6 days to avoid this.
- Moodle and TUM-Live logins through TUM SSO fail for accounts that must use a second factor or a passkey.

## License

MIT. See [LICENSE](LICENSE).
