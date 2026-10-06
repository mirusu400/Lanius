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

**Copy as** reflects your edits, so the generated curl, `fetch` or Python
`requests` code repeats exactly the request you are fuzzing. See
[proxy history](proxy.md) for details.
