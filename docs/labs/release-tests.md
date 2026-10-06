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
| 2026-10-05 10:36 | az104-01-identity | 1 | pass | yes | none | 1m 40s | 5m 34s | £0.0000 | 37296777396 |
| 2026-10-05 14:53 | az104-16-lb-appgw | 2 | fail | yes | none | — | 1m 12s | £0.0048 | 37327900625 |
| 2026-10-05 14:54 | az104-19-backup | 1 | fail | yes | none | — | 1m 11s | £0.0004 | 37327906838 |
| 2026-10-05 15:02 | az104-06-blob-security | 2 | pass | yes | none | 2m 23s | 5m 27s | £0.0011 | 37328416085 |
| 2026-10-05 15:09 | az104-08-vms | 1 | pass | yes | none | 2m 40s | 3m 29s | £0.0023 | 37329556090 |
| 2026-10-05 15:15 | az104-09-vmss | 1 | pass | yes | none | 2m 19s | 3m 23s | £0.0021 | 37330509902 |
| 2026-10-05 15:22 | az104-10-app-service | 1 | fail | yes | none | — | 2m 2s | £0.0022 | 37331396196 |
| 2026-10-05 15:27 | az104-12-bicep | 1 | pass | yes | none | 1m 27s | 2m 20s | £0.0000 | 37332314784 |
| 2026-10-05 15:27 | az104-11-containers | 1 | pass | yes | none | 3m 46s | 29m 3s | £0.0136 | 37328478959 |
| 2026-10-05 15:34 | az104-13-vnets | 1 | pass | yes | none | 2m 28s | 3m 27s | £0.0022 | 37333031725 |
| 2026-10-05 15:41 | az104-14-peering-udr | 1 | pass | yes | none | 2m 53s | 3m 29s | £0.0035 | 37333977115 |
| 2026-10-05 15:52 | az104-15-dns | 1 | pass | yes | none | 3m 19s | 5m 58s | £0.0019 | 37334916778 |
| 2026-10-05 15:59 | az104-17-netwatcher-fix | 1 | pass | yes | none | 3m 26s | 3m 28s | £0.0025 | 37336288394 |
| 2026-10-05 16:08 | az104-18-monitor | 1 | pass | yes | none | 4m 18s | 3m 26s | £0.0015 | 37337319164 |
| 2026-10-05 16:29 | az104-19-backup | 2 | pass | yes | none | 5m 41s | 10m 0s | £0.0057 | 37339121948 |
| 2026-10-05 16:33 | az104-16-lb-appgw | 2 | pass | yes | none | 10m 15s | 9m 30s | £0.0788 | 37339119265 |
| 2026-10-05 16:39 | az104-10-app-service | 2 | fail | yes | none | — | 1m 51s | £0.0023 | 37341793982 |
| 2026-10-06 04:46 | az305-25-storage-design | 1 | pass | yes | none | 1m 38s | 2m 33s | £0.0000 | 37414873088 |
| 2026-10-06 05:03 | az305-20-landing-zone | 1 | pass | yes | none | 3m 56s | 12m 45s | £0.0000 | 37415260283 |
| 2026-10-06 05:06 | az305-27-multi-region | 1 | pass | yes | none | 4m 19s | 20m 11s | £0.0320 | 37414875062 |
| 2026-10-06 05:16 | az305-21-monitoring-scale | 1 | pass | yes | none | 6m 54s | 5m 23s | £0.0001 | 37416640571 |
| 2026-10-06 05:23 | az305-23-sql-failover | 1 | pass | yes | none | 9m 27s | 6m 36s | £0.0405 | 37416882171 |
| 2026-10-06 05:27 | az305-22-keyvault-mi | 1 | pass | yes | none | 6m 23s | 3m 16s | £0.0017 | 37417724811 |
| 2026-10-06 05:42 | az305-24-cosmos | 1 | pass | yes | none | 3m 27s | 10m 45s | £0.0006 | 37418603934 |
| 2026-10-06 05:49 | az305-26-site-recovery | 2 | fail | yes | none | — | 6m 14s | £0.0066 | 37418264048 |
| 2026-10-06 06:46 | az305-25-storage-design | 2 | pass | yes | none | 1m 27s | 2m 22s | £0.0000 | 37425201115 |
| 2026-10-06 07:02 | az305-20-landing-zone | 2 | pass | yes | none | 3m 59s | 11m 25s | £0.0000 | 37425632226 |
| 2026-10-06 07:17 | az305-22-keyvault-mi | 2 | pass | yes | none | 6m 15s | 3m 35s | £0.0018 | 37427708400 |
| 2026-10-06 07:23 | az305-23-sql-failover | 2 | pass | yes | none | 9m 7s | 6m 4s | £0.0383 | 37427709522 |
| 2026-10-06 07:23 | az305-21-monitoring-scale | 2 | pass | yes | none | 6m 35s | 5m 15s | £0.0001 | 37427238049 |
| 2026-10-06 07:32 | az305-24-cosmos | 2 | pass | yes | none | 2m 57s | 10m 33s | £0.0006 | 37428794963 |
| 2026-10-06 07:50 | az305-26-site-recovery | 3 | pass | yes | none | 60m 11s | 7m 18s | £0.0710 | 37425197793 |
| 2026-10-06 07:58 | az305-27-multi-region | 2 | pass | yes | none | 4m 24s | 20m 39s | £0.0327 | 37430276351 |
