# Fuzzer

Mark payload positions and run a wordlist against them. Four run modes are
supported:

| Type | Behaviour |
|---|---|
| Single position | One position at a time |
| Shared payload | The same value in every position |
| Lockstep | Payload sets advance together |
| Cartesian product | Every combination |

Results show status, length and timing, and responses whose length stands out
from the rest are highlighted automatically, so a successful login in a pile of
failures is hard to miss.

Drag the divider between the request template and payload sets to adjust their
heights. The position is remembered; double-click the divider to reset it.

Each payload set has a **Payload Maker** button. In its dialog, generate an
integer range (inclusive end, positive step, optional zero padding), character
combinations (shorter strings first, using a custom alphabet), a date range,
or process the current set. Date ranges support a positive day interval and
six output formats such as `YYYY-MM-DD`, `YYYYMMDD`, and `YYMMDD`; they include
leap days and are independent of timezones and daylight saving. Both date and
numeric ranges can count down, and integers retain their precision
even above JavaScript's usual safe integer range.

Add and reorder processing steps for prefixes, suffixes, URL component encoding
(`%20` spaces), form encoding (`+` spaces), UTF-8 Base64 / URL-safe Base64 with
optional padding, case conversion, literal text replacement, and deduplication.
Steps run from top to bottom; deduplication uses values at that point in the
chain and applies within the generated list, not against existing entries when
appending.

The preview shows the first 100 source values alongside their processed output,
the source count, and upper bounds on requests for replacing or appending to the
set with the current run mode. Choose **Replace current set** or **Append to
current set** to apply; the existing Save button can then save the result.
Generation runs locally in a cancellable worker and makes no network requests.
Sources are limited to 100,000 values, and the applied list (including existing
entries when appending) to 100,000 payloads / 8 MiB. All values are checked when
applying; a failure leaves the set unchanged. Final values must fit the current
one-payload-per-line format: encode line breaks or surrounding whitespace before
applying them.

Each request sent to Fuzzer opens its own tab, so editing or running another
request does not replace an existing run. Tabs and drafts are saved in the
project workspace. Run history and results are saved in the project database;
use **Run history** to reopen a completed run after closing its tab or restarting
Lanius. The Dashboard shows active runs and their progress. Runs interrupted by
an engine restart are marked stopped when the project is reopened.

**Copy as** reflects your edits, so the generated curl, `fetch` or Python
`requests` code repeats exactly the request you are fuzzing. See
[proxy history](proxy.md) for details.

The HTTP version selector applies a project default or explicit Auto,
HTTP/1.0, HTTP/1.1, or HTTP/2 mode to every request in the run. It is saved with
the draft and run history. The effective mode is fixed when the run starts.
Forced HTTP/2 requires HTTPS and fails without h2 negotiation. Open a result's
flow to inspect the recorded server direction protocol.
