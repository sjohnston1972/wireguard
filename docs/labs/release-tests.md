# Lab release tests

One row per real-Azure release test (labs spec §11.2), appended by `node scripts/lab-release-test.mjs`.
A lab version is released when its test passes with clean = yes. Times are the run's own; £ is the
lab's hourly estimate times those minutes.

| Date (UTC) | Lab | Version | Result | Clean | Leftovers | Deploy | Destroy | Est. £ | Run |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-05 09:15 | az104-04-cost | 1 | fail | no | unverified: management groups | 1m 2s | — | £0.0000 | 37288205618 |
| 2026-10-05 09:22 | az104-05-storage | 1 | fail | no | unverified: management groups | 2m 19s | — | £0.0000 | 37288823093 |
| 2026-10-05 09:30 | az104-07-files | 1 | fail | no | unverified: management groups | 2m 30s | — | £0.0005 | 37289559103 |
| 2026-10-05 09:46 | az104-04-cost | 1 | pass | yes | none | 0m 56s | 2m 1s | £0.0000 | 37291800658 |
| 2026-10-05 09:51 | az104-05-storage | 1 | pass | yes | none | 2m 29s | 2m 7s | £0.0000 | 37292220829 |
| 2026-10-05 09:57 | az104-07-files | 1 | pass | yes | none | 2m 20s | 3m 5s | £0.0010 | 37292796282 |
| 2026-10-05 10:02 | az104-01-identity | 1 | fail | yes | none | — | 1m 9s | £0.0000 | 37293435183 |
| 2026-10-05 10:10 | az104-02-policy | 1 | pass | yes | none | 4m 1s | 3m 48s | £0.0000 | 37293933547 |
| 2026-10-05 10:18 | az104-03-mgmt-groups | 1 | pass | yes | none | 3m 57s | 3m 23s | £0.0000 | 37294886487 |
| 2026-10-05 10:27 | az104-06-blob-security | 1 | pass | yes | none | 2m 24s | 5m 26s | £0.0011 | 37295767424 |
