# day-trader-skill (vendored)

Six standard-library Python tools from
[Jakeschincariol/day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill)
at commit `3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd`, copied unmodified under its MIT license (see `LICENSE`).

| file | upstream | used by |
| --- | --- | --- |
| `timemachine.py` | trader-timemachine | `/api/trader/timemachine` |
| `size.py` | trader-budget | `/api/trader/size` |
| `check.py` | trader-risk | `/api/trader/size` |
| `scan.py` | trader-scanner | `/api/trader/scan` |
| `facts.py` | trader-analyst | `/api/trader/earnings/:symbol` |
| `ptr.py` | trader-pelosi | `/api/trader/congress` |

The order executor (trader-broker) is deliberately not included: OpenTerminal
never places orders. To update, copy the same files from a newer upstream
commit and bump the hash above.
