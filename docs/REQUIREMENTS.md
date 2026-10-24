# Collector requirements

The owner's rules live outside this repository. The watcher (Claude) applies them. Do not put them in code.

This file lists only what the collector must do technically.

## Role

- The worker is a pure collector. It never interprets, plans, names or decides.
- No rule of the owner goes into the repository or the code. A separate Claude chat (the watcher) applies the rules to the collector output.
- The collector only reads. The connector keeps its write tools (mail, Zulip, Moodle, Artemis) for later use.

## Each run

1. Read all sources.
2. Store the last state per source and per item in D1 `tum-mcp` and R2 `tum-files`.
3. Return the exact delta since the last run.

Every item in the delta has its source and a link to the original.

## Scope

| Source | Collected |
| --- | --- |
| Mail | Mails from 15 September 2026 on, in all folders (also Trash and Sent) |
| Zulip | Messages from 15 September 2026 on |
| Moodle | The courses in `config/moodle-courses.json`: listed course ids, plus every course whose Moodle name contains one of the listed texts (case ignored) |
| Artemis, TUM-Live | Only courses of the current semester (winter 2026/27). Courses of earlier semesters are left out. |
| TUMonline | No limit |
| ITS scoreboard | Every page on `scoreboard.sec.in.tum.de` linked from the scoreboard, read only |
| External course websites | The sites in `config/external-sites.json`: the start pages and every linked page and file under the listed URL prefixes of the same site, read only |

Items outside the scope never appear in the collector output, neither as new nor as removed.

Moodle is read completely: activity pages, resources, folders, forums, the course page and the grade report. Moodle "viewed" and completion marks may be set by this.

## Delta types

| Type | Content |
| --- | --- |
| New | The complete content. |
| Changed | The complete new content, plus every changed part with its old and new value. |
| Removed | The last known content. |

Complete content per source:

- Mail: the whole mail with sender, recipients, subject, body and attachments.
- Moodle: the whole page of every activity, every section (also in courses that show one section per page), every announcement and forum discussion with all posts, every file.
- Artemis: exercises with details, exams, lectures with attachment files, notifications.
- Zulip: the whole message.
- TUMonline: all fields as TUMonline returns them.
- TUM-Live: all stream fields and the link.
- External course websites: every page with its text, links, dates and tables, and every file. On sites with an `unlock` entry also the links that the page unlocks with an access token. The collector reads the token from a stored Moodle announcement or mail and never stores it.
- ITS scoreboard: every page and file the user sees there when logged in (scoreboard, tasks and each task page, course materials, presentation booking, tutorial attendance, team or registration state, SSH keys, and every page linked from them).

Web pages:

- The full text with all links and dates.
- The HTML is stored in R2 and can be read on request.

Files:

- Files up to 100 MB are stored in R2. Large files are streamed into R2, so the worker never holds a whole large file in memory.
- Videos and files over 100 MB are not downloaded. Only the link is kept.
- The collector makes no text from files. It gives each file with its link and its R2 key. The watcher reads every PDF itself, because machine-made text can contain invented content.

## First run

There is no stored state on the first run. The delta therefore contains everything inside the scope.

## TUMonline sources

| Data | Source | Login |
| --- | --- | --- |
| Exam deadlines | Public exam list (`ee/rest/slc.xm.exd/exExamOffer`, as `tumonline_public_exams`) | none |
| My registered exams | Token function `pruefungenEigene` | TUMonline token |
| Exam room | TUMonline calendar, token function `kalender` | TUMonline token |
| Course registration and deregistration periods | Public course data, REST `courses/{id}/registrationProcedures` | none |
| My courses | Token function `veranstaltungenEigene`, plus course numbers from the calendar as fallback | TUMonline token |

The public exam list holds all TUM exams. The collector keeps only the entries of my courses. An entry is mine when its course id, its course number or its course name (German or English) is one of mine. Names must be equal after trimming, joining white space and ignoring case. No other matching is done.

There is no automated TUMonline web login.

## Tools

- `collector_run` runs the collection and returns the deltas after the delivered pointer, in pages (`after`, `next_after`, `more`). It never moves the pointer.
- `collector_ack` moves the delivered pointer to the `next_after` of the last page. The caller calls it only after it processed the deltas and saved its results. Delivery is therefore at least once: a call that breaks off loses nothing.
- `next` for `collector_ack` must be the current pointer or an existing delta id above it. The pointer never moves backwards.
- `collector_item` returns the full stored content of an item, the stored HTML and the stored files. A file up to 4 MB comes in the result. A larger file (up to 100 MB) comes as a signed download link that is valid for one hour. `download_link: true` gives the link also for small files.

## ITS scoreboard

The collector only reads the scoreboard. It sends only GET requests and never sends a form. It never submits, registers, joins a team, books, adds or deletes anything, and never logs out. Links with such an action are not requested.

Tools for a chat (read only): `its_scoreboard_page` (one page), `its_scoreboard_task` (one task page), `its_scoreboard_team` (team or registration state).

