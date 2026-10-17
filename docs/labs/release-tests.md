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
| 2026-10-06 08:52 | az305-26-site-recovery | 4 | pass | yes | none | 40m 7s | 8m 29s | £0.0511 | 37433506191 |
| 2026-10-06 11:38 | az104-13-vnets | 2 | pass | yes | none | 3m 7s | 4m 9s | £0.0027 | 37456851757 |
| 2026-10-06 11:46 | az104-14-peering-udr | 2 | pass | yes | none | 2m 52s | 3m 55s | £0.0037 | 37457752516 |
| 2026-10-06 11:50 | az104-16-lb-appgw | 3 | pass | yes | none | 9m 54s | 10m 6s | £0.0798 | 37456855442 |
| 2026-10-06 11:56 | az104-15-dns | 2 | pass | yes | none | 2m 48s | 6m 25s | £0.0018 | 37458594223 |
| 2026-10-06 12:04 | az104-17-netwatcher-fix | 2 | pass | yes | none | 3m 8s | 4m 10s | £0.0027 | 37459739721 |
| 2026-10-06 12:14 | az700-38-hub-firewall | 1 | pass | yes | none | 10m 3s | 11m 59s | £0.1221 | 37459151590 |
| 2026-10-06 12:26 | az700-32-dns-resolver | 1 | pass | yes | none | 3m 57s | 7m 25s | £0.0752 | 37461811263 |
| 2026-10-06 12:32 | az305-27-multi-region | 3 | pass | yes | none | 4m 21s | 22m 55s | £0.0356 | 37460660230 |
| 2026-10-06 12:39 | az700-31-ip-nat-outbound | 1 | pass | yes | none | 2m 40s | 3m 53s | £0.0101 | 37463932093 |
| 2026-10-06 12:45 | az700-35-forced-tunnel-fix | 1 | pass | yes | none | 2m 14s | 3m 16s | £0.0020 | 37464855594 |
| 2026-10-06 12:52 | az700-41-appgw-waf | 1 | pass | yes | none | 13m 46s | 11m 17s | £0.1573 | 37463244307 |
| 2026-10-06 12:56 | az700-43-private-link | 1 | pass | yes | none | 4m 14s | 6m 19s | £0.0098 | 37465605223 |
| 2026-10-06 13:09 | az700-40-lb-advanced | 2 | fail | yes | none | — | 5m 55s | £0.0123 | 37466999221 |
| 2026-10-06 13:20 | az700-33-vnet-manager | 2 | fail | yes | none | — | 6m 30s | £0.0072 | 37468580167 |
| 2026-10-06 13:22 | az700-42-frontdoor-private | 2 | fail | yes | none | — | 22m 26s | £0.1387 | 37466412490 |
| 2026-10-06 13:52 | az700-34-route-server | 1 | pass | yes | none | 18m 10s | 10m 38s | £0.1751 | 37470264092 |
| 2026-10-06 13:52 | az700-44-flow-logs-bastion | 1 | pass | yes | none | 16m 29s | 12m 37s | £0.0885 | 37470060551 |
| 2026-10-06 14:04 | az700-33-vnet-manager | 2 | pass | yes | none | 2m 56s | 4m 34s | £0.0083 | 37474825292 |
| 2026-10-06 14:14 | az700-40-lb-advanced | 3 | pass | yes | none | 2m 26s | 6m 23s | £0.0183 | 37475947305 |
| 2026-10-06 14:38 | az700-37-p2s-vpn | 1 | pass | yes | none | 25m 55s | 14m 32s | £0.1166 | 37474828880 |
| 2026-10-06 14:41 | az700-36-s2s-vpn | 2 | pass | yes | none | 26m 42s | 17m 2s | £0.2522 | 37474833372 |
| 2026-10-06 14:42 | az700-42-frontdoor-private | 3 | pass | yes | none | 4m 56s | 22m 13s | £0.1678 | 37477274659 |
| 2026-10-06 15:18 | az700-39-vwan-secured-hub | 2 | pass | yes | none | 45m 39s | 35m 2s | £0.6971 | 37474835793 |
| 2026-10-06 15:38 | az104-15-dns | 3 | pass | yes | none | 2m 19s | 6m 37s | £0.0018 | 37487715359 |
| 2026-10-06 15:38 | az700-44-flow-logs-bastion | 2 | fail | yes | none | — | 4m 22s | £0.0133 | 37487717733 |
| 2026-10-06 16:02 | az700-41-appgw-waf | 2 | pass | yes | none | 12m 46s | 11m 6s | £0.1499 | 37489157154 |
| 2026-10-06 16:04 | az700-42-frontdoor-private | 4 | pass | yes | none | 4m 28s | 19m 49s | £0.1501 | 37489265536 |
| 2026-10-06 16:30 | az700-44-flow-logs-bastion | 2 | pass | yes | none | 13m 18s | 12m 12s | £0.0776 | 37492756118 |
| 2026-10-06 22:32 | az104-14-peering-udr | 2 | pass | yes | none | 2m 51s | 3m 57s | £0.0038 | 37540459971 |
| 2026-10-07 07:59 | az305-30-messaging | 1 | pass | yes | none | 4m 1s | 29m 2s | £0.0061 | 37587213098 |
| 2026-10-07 08:00 | az305-28-three-tier | 1 | pass | yes | none | 6m 34s | 28m 16s | £0.0586 | 37587215807 |
| 2026-10-07 08:17 | az305-29-aks | 1 | pass | yes | none | 7m 26s | 9m 0s | £0.0209 | 37590798443 |
| 2026-10-07 09:39 | az305-30-messaging | 1 | pass | yes | none | 4m 23s | 30m 17s | £0.0064 | 37597977667 |
| 2026-10-07 10:16 | az305-28-three-tier | 1 | pass | yes | none | 7m 37s | 28m 55s | £0.0615 | 37602104057 |
| 2026-10-15 16:39 | soa-04-backup | 1 | fail | yes | none | — | 2m 45s | £0.0002 | 38769273888 |
| 2026-10-15 17:12 | soa-04-backup | 2 | fail | yes | none | — | 2m 26s | £0.0002 | 38773860024 |
| 2026-10-15 17:47 | soa-04-backup | 3 | pass | yes | none | 5m 8s | 3m 13s | £0.0006 | 38778966396 |
| 2026-10-15 17:59 | soa-01-cloudwatch | 2 | fail | yes | none | — | 5m 0s | £0.0026 | 38780244745 |
| 2026-10-15 18:11 | soa-03-auto-scaling | 2 | fail | yes | none | — | 3m 54s | £0.0032 | 38781875647 |
| 2026-10-15 18:23 | soa-02-systems-manager | 2 | fail | yes | none | — | 5m 39s | £0.0041 | 38783513154 |
| 2026-10-15 19:03 | soa-05-rds | 2 | fail | no | rds:snapshot rds:db-a05tcci3-2026-10-15-18-40 (db-primary), rds:snapshot rds:db-a05tcci3-2026-10-15-18-37 (db-primary) | 26m 20s | — | £0.0233 | 38785247607 |
| 2026-10-15 20:02 | soa-01-cloudwatch | 2 | pass | yes | none | 3m 59s | 6m 1s | £0.0051 | 38797196994 |
| 2026-10-15 20:13 | soa-03-auto-scaling | 2 | pass | yes | none | 5m 52s | 4m 1s | £0.0081 | 38798688113 |
| 2026-10-15 20:25 | soa-02-systems-manager | 3 | pass | yes | none | 3m 51s | 7m 37s | £0.0083 | 38800159538 |
| 2026-10-15 21:04 | soa-05-rds | 2 | pass | yes | none | 30m 22s | 7m 44s | £0.0337 | 38801816428 |
| 2026-10-16 03:43 | soa-06-cloudformation | 1 | pass | yes | none | 1m 59s | 3m 2s | £0.0000 | 38846428615 |
| 2026-10-16 03:47 | soa-07-iam-kms | 1 | pass | yes | none | 0m 58s | 2m 10s | £0.0001 | 38846915937 |
| 2026-10-16 03:47 | soa-09-route53-cloudfront | 1 | pass | yes | none | 3m 45s | 4m 42s | £0.0002 | 38846492150 |
| 2026-10-16 03:56 | soa-08-vpc-fix | 1 | fail | yes | none | — | 2m 18s | £0.0005 | 38847236216 |
| 2026-10-16 03:58 | soa-10-containers | 1 | pass | yes | none | 3m 58s | 5m 41s | £0.0151 | 38847282221 |
| 2026-10-16 04:04 | soa-04-backup | 4 | pass | yes | none | 5m 2s | 2m 45s | £0.0006 | 38848014785 |
| 2026-10-16 04:09 | soa-01-cloudwatch | 3 | pass | yes | none | 3m 59s | 6m 23s | £0.0053 | 38848167168 |
| 2026-10-16 04:20 | soa-05-rds | 3 | pass | yes | none | 28m 14s | 12m 33s | £0.0360 | 38846554109 |
| 2026-10-16 04:31 | soa-03-auto-scaling | 3 | pass | yes | none | 6m 19s | 3m 24s | £0.0080 | 38850131479 |
| 2026-10-16 04:41 | soa-02-systems-manager | 4 | pass | yes | none | 3m 57s | 5m 4s | £0.0065 | 38851045443 |
| 2026-10-16 04:53 | soa-08-vpc-fix | 2 | pass | yes | none | 3m 54s | 3m 51s | £0.0016 | 38852201889 |
| 2026-10-16 16:13 | saa-12-serverless-api | 1 | pass | yes | none | 1m 1s | 1m 40s | £0.0000 | 38929752740 |
| 2026-10-16 16:13 | saa-17-data-pipeline | 1 | pass | yes | none | 1m 9s | 1m 32s | £0.0006 | 38929801604 |
| 2026-10-16 16:22 | saa-13-decoupling | 1 | pass | yes | none | 2m 4s | 5m 17s | £0.0000 | 38930281683 |
| 2026-10-16 16:26 | saa-16-dr-pilot-light | 1 | pass | yes | none | 6m 0s | 5m 43s | £0.0011 | 38930312661 |
| 2026-10-16 16:30 | saa-15-data-security | 1 | pass | yes | none | 3m 50s | 3m 6s | £0.0006 | 38931422250 |
| 2026-10-16 16:39 | saa-14-storage | 1 | pass | yes | none | 4m 28s | 2m 57s | £0.0021 | 38932487877 |
| 2026-10-16 16:41 | saa-11-three-tier | 1 | pass | yes | none | 18m 23s | 11m 58s | £0.0677 | 38929851114 |
| 2026-10-16 16:46 | saa-18-cost-compute | 1 | pass | yes | none | 3m 55s | 2m 56s | £0.0017 | 38933612894 |
| 2026-10-16 17:11 | saa-19-eks | 1 | pass | yes | none | 13m 55s | 13m 59s | £0.0681 | 38933998495 |
| 2026-10-17 10:48 | ans-22-s2s-vpn | 1 | fail | yes | none | — | 1m 5s | £0.0010 | 39026020372 |
| 2026-10-17 10:59 | ans-23-hybrid-dns | 1 | pass | yes | none | 4m 42s | 4m 52s | £0.0613 | 39026306184 |
| 2026-10-17 11:00 | ans-21-transit-gateway | 1 | fail | yes | none | — | 7m 32s | £0.0233 | 39026046930 |
| 2026-10-17 11:14 | ans-25-load-balancing | 1 | pass | yes | none | 7m 0s | 6m 39s | £0.0345 | 39027015671 |
| 2026-10-17 11:15 | ans-29-multi-region | 1 | pass | yes | none | 5m 58s | 9m 14s | £0.0451 | 39026967542 |
| 2026-10-17 11:15 | ans-20-vpc-design | 1 | pass | yes | none | 5m 23s | 25m 32s | £0.0235 | 39025992056 |
| 2026-10-17 11:25 | ans-24-privatelink | 1 | pass | yes | none | 4m 40s | 4m 25s | £0.0063 | 39028009441 |
| 2026-10-17 11:28 | ans-26-edge | 1 | fail | yes | none | — | 3m 31s | £0.0048 | 39027988912 |
| 2026-10-17 11:30 | ans-27-network-firewall | 1 | pass | yes | none | 6m 37s | 7m 38s | £0.1145 | 39027970290 |
| 2026-10-17 11:34 | ans-28-flow-logs-fix | 1 | pass | yes | none | 4m 3s | 3m 21s | £0.0046 | 39028659891 |
| 2026-10-17 11:36 | ans-22-s2s-vpn | 1 | pass | yes | none | 10m 29s | 4m 13s | £0.0131 | 39028349367 |
| 2026-10-17 11:53 | ans-30-vpc-lattice | 1 | fail | yes | none | — | 4m 12s | £0.0035 | 39029207914 |
| 2026-10-17 12:06 | ans-31-client-vpn | 1 | pass | yes | none | 6m 23s | 5m 45s | £0.0236 | 39030414504 |
| 2026-10-17 12:13 | ans-21-transit-gateway | 1 | pass | yes | none | 4m 8s | 7m 54s | £0.0372 | 39030790866 |
| 2026-10-17 12:14 | soa-08-vpc-fix | 2 | pass | yes | none | 3m 57s | 2m 50s | £0.0014 | 39031253167 |
| 2026-10-17 12:27 | ans-26-edge | 1 | fail | yes | none | — | 3m 43s | £0.0050 | 39031657786 |
| 2026-10-17 12:42 | ans-30-vpc-lattice | 1 | pass | yes | none | 4m 14s | 6m 34s | £0.0091 | 39032781215 |
| 2026-10-17 13:16 | ans-26-edge | 1 | fail | unknown | unknown | — | — | — | 39035632924 |
| 2026-10-17 13:30 | ans-26-edge | 2 | pass | yes | none | 5m 55s | 7m 7s | £0.0177 | 39035938358 |
