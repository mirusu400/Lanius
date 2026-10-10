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

Each request sent to Fuzzer opens its own tab, so editing or running another
request does not replace an existing run. Tabs and drafts are saved in the
project workspace. Run history and results are saved in the project database;
use **Run history** to reopen a completed run after closing its tab or restarting
Lanius. The Dashboard shows active runs and their progress. Runs interrupted by
an engine restart are marked stopped when the project is reopened.

**Copy as** reflects your edits, so the generated curl, `fetch` or Python
`requests` code repeats exactly the request you are fuzzing. See
[proxy history](proxy.md) for details.
