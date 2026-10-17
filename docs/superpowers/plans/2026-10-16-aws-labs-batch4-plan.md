# AWS labs batch 4 (labs 20–31) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ANS-C01 labs `ans-20-vpc-design`, `ans-21-transit-gateway`, `ans-22-s2s-vpn`, `ans-23-hybrid-dns`, `ans-24-privatelink`, `ans-25-load-balancing`, `ans-26-edge`, `ans-27-network-firewall`, `ans-28-flow-logs-fix`, `ans-29-multi-region`, `ans-30-vpc-lattice` and `ans-31-client-vpn` run in cloudlabs as batches 1–3's do and pass a real-AWS release test with `clean: true`, together with the engine parts they first need: transit gateways (with inter-region peering), site-to-site VPN, Route 53 Resolver (DNS Firewall, query logging), PrivateLink endpoint services, the Gateway Load Balancer, Global Accelerator in us-west-2, CloudFront origin groups, Functions and WAF, Network Firewall, traffic mirroring, flow logs to S3 with Athena, VPC Lattice, Client VPN with certificates imported from `tls`, IPAM's free tier and IPv6, prefix lists, and the `files` output (migration `0025_lab_files.sql`, the Worker's secret route and the lab modal's Download buttons).

**Architecture:** The engine keeps its shape; lists, rules and handlers grow. The ABAC generator learns one thing the real reference forces (a peering's accepter side carries no lab tag until it is accepted), the role gains three service-linked roles, one account-setting deny and one create-tag exemption the provider forces (a traffic mirror filter rule takes no tags, P17), and nothing else in IAM moves. `lab-scope-aws.mjs` gains batch 4's types and a `batch4Problems` switch that keeps each new kind of reference (attachments, tunnels, resolver rules, endpoint services, accelerators, auth policies, mirror targets, Client VPN networks) inside the lab, plus three cross-cutting fixes carried from earlier batches: IPv6 "internet" is any global IPv6 range, every service-principal Allow names its source, and vended logs go to the lab's bucket only. The safety net and Verify clean gain a handler and a real-state read per new type in the spec's §8.2 order, across four regions for `ans-26-edge`. The Worker stores lab 31's `files` on the deploy run (migration 0025), hands them out only through `GET /labs/:id/secret`, clears them at session end, and reads us-west-2 for Global Accelerator. Each lab is a folder, a learning file, a planned topology, a plan fixture and a test file, in batch 3's lab-task shape, written from the binding design sheet below.

**Tech Stack:** Terraform 1.14.6 with `hashicorp/aws ~> 6.0` (6.69.0 in the fixtures), `random`, `time`, `tls`; AWS CLI v2 + jq + bash (pipeline scripts); node:test (`scripts/test`); Cloudflare Worker and D1 (TypeScript, vitest); React web (vitest + Testing Library).

**Spec:** `docs/superpowers/specs/2026-10-15-aws-labs-design.md` (binding, rulings A1–A109; §3–§10, §12.2 rows 20–31 and "Not built here", §14 item 4, §15). Section numbers below (§n) are that spec's. Batch 3's plan (`docs/superpowers/plans/2026-10-16-aws-labs-batch3-plan.md`) is the model for each task's shape; its code is on `main` (48dc704).

## Global Constraints

- Steven's standing go (memory `aws-labs-autonomy.md`): plan, build, merge, deploy, bootstrap re-apply, quota requests and real-AWS release tests without stops. STOP only for: a surprise; AWS test spend that would pass **£15 for the whole AWS labs project** (about **£0.33** spent so far; batch 4 aims at **≤ £4**); or **any change to the VPN server**: `infra/aws/**`, `infra/main.tf`, `infra/cloud-init.yaml.tftpl`, `.github/workflows/wg.yml`, `.github/workflows/wg-aws.yml`, or the `wg-admin-deploy` role (its policy in `infra/aws-bootstrap/main.tf`). No task in this plan touches any of them; a fix that seems to need one is a STOP, designed around, never made.
- Labs run in **eu-west-2** (London). **eu-west-1** (Ireland) only where §12.2 puts it: lab 26's Ireland instance and load balancer, and lab 29 (`regions.secondary`, provider alias `secondary`). **us-east-1** only for global APIs (A65): lab 26's WAF web ACL (scope CLOUDFRONT, per-resource `region`) and CloudFront (signed there by the default provider); Route 53 private zones (labs 23, 24) are signed there by the default provider and listed there (A87, P1). **us-west-2** only for Global Accelerator, lab 26 only (P9). No other region, and no fourth provider block in any lab.
- Azure behaviour and batches 1–3's AWS behaviour do not change except where a task names the change. Every existing test stays green unchanged except those this plan names. No existing AWS lab's folder changes, so no soa-*/saa-* version bump and no retest.
- An AWS lab owns: everything tagged `cloudlabs-lab = <id>`; IAM roles, instance profiles and customer policies at path `/cloudlabs-lab/` named `lab-<id>-*`; S3 buckets `cloudlabs-<name_prefix>-*`; untaggable types named `lab-<id>-*` (A4: here CloudFront functions); log groups `/cloudlabs/<id>/...` (A56); DynamoDB tables and AMI copies named `lab-<id>-*`, Glue databases `lab_<id with _>` (A85, A86, A97).
- Every `aws` provider block is exactly §4's (the default one in the template's `versions.tf`; a `secondary` one in labs 26 and 29). Instances as batches 1–3 (AL2023 arm64 from the SSM parameter, IMDSv2, `volume_tags`, no public IPv4, `labadmin` with the session password, console SSH through an Instance Connect Endpoint, a free S3 gateway endpoint), with two exceptions this plan rules: lab 22's router is Ubuntu 24.04 arm64 with an Elastic IP (§7.4, P11), lab 25's appliance a `t4g.small` (P14). Every lab that can peer copies `labs/_template-aws/network.tf` unchanged (`commonAwsProblems`); its VPC `vpc-lab` is the lab's hub. IAM documents with `jsonencode()` only (A42).
- Every batch 4 lab is designed to pass first time under A47–A109: tags at create (A49) and the provider sending them in the create call (each new type's `Create*` checked against the reference's condition keys, 2026-10-16, Task 2); create-needs-tag ABAC with the exemptions A54, A55, A86 and this plan's P3 only; delete/update verbs never creates (A59); no service-made log group and no account-wide logs resource policy (P8); service-linked roles made ahead (A57, P4); a 20-second wait before the first tag-checked change on a service not yet proven (A73, P21); AWS authorising an action on resources other than the one named (A82: checked per action in Task 2's table); nothing AWS makes untagged inside a lab VPC that the role could not delete (P9's Global Accelerator choice); the scope check failing closed on unknown values without references; a null optional attribute counting as unset.
- Never read or print `.env`. Subagents copy `.env.example` (never the real `.env`) and never use the AWS admin keys; only the controller runs `scripts/aws-bootstrap.mjs`, `npm run labs-verify -- --aws-prices`, read-only AWS checks and real-AWS release tests. Kill processes only by PID. Do not use `python3` on this Windows machine (tests needing Python+PyYAML, bash, jq or terraform skip with a reason when missing; CI has them all).
- Files start with the house header comment (`// path/file` then a `// Plain English: …` paragraph; `#` for shell, HCL, YAML and SQL `--`). Match the surrounding comment density and naming.
- Tests while building: only the targeted files (`node --test scripts/test/<file>`, `npx vitest run <files>`), plus `npm run typecheck` when TypeScript changes. The full gate runs once, in Task 23, and runs the vitest suites explicitly (`npx vitest run`): local `npm test` stops at the four known Azure "Remove lab peerings" node-test failures before vitest starts.
- **One D1 migration:** `worker/migrations/0025_lab_files.sql` (`lab_runs.files_json`, A13). `npm run demo-schema` regenerates `worker/src/demo/schema.gen.ts` with it (its test pins the copy).
- Work on branch `feat/aws-labs-batch4` (from `main` at 48dc704). Commit after each task. Commit messages end with `Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3`; PR bodies end with `https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3`.

## Plan rulings (copied into spec §17 as A110–A135 in Task 23)

- **P1 (A110). Batch 4's contract lists.** `AWS_FILES_LABS = ["ans-31-client-vpn"]` (the only labs whose Terraform may declare a `files` output), `AWS_GA_LABS = ["ans-26-edge"]` with `readsUsWest2(id)` (the Worker's reads add us-west-2 only for them; Parse payload's `LAB_REGIONS` already lists us-west-2 for every `AWS_GLOBAL_LABS` lab), and `AWS_PEER_REGION_LABS = ["ans-29-multi-region"]` (the only labs whose VPC peering or transit gateway peering crosses to the session's secondary region). `AWS_DNS_LABS` (A87) gains `ans-23-hybrid-dns` and `ans-24-privatelink`: their private hosted zones are Route 53 items the tagging API lists in us-east-1 only, so Parse payload's `LAB_REGIONS`, the safety net, Verify clean and the Worker's reads add us-east-1 for them. Reason: each opens a door one lab needs and no other.
- **P2 (A111). Lab files travel beside the result, never in it.** Step 16 sends the `files` output in the callback body's own top-level `files` key, only for a succeeded `deploy` or `test` of an `AWS_FILES_LABS` lab, never in `LAB_RESULT` or `outputs`. The Worker refuses `files` for any other lab or run, accepts at most 8 files, each name `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and each text at most 16 KiB (48 KiB together), stores them on the run (`lab_runs.files_json`, migration 0025), returns them only from `GET /labs/:id/secret` (always a `files` object, `{}` when none) while the session runs, and clears them at session end with the admin password (`clearPasswords` becomes `clearSecrets`). `lab-lint --cloud aws` refuses an `output "files"` outside `AWS_FILES_LABS` or without `sensitive = true`. Reason: A13; a client key must never sit in a log, a session row or the result line.
- **P3 (A112). Peering accepts are exempt from the change-needs-lab-tag rule.** `ec2:AcceptVpcPeeringConnection` and `ec2:AcceptTransitGatewayPeeringAttachment` join `CHANGE_TAG_EXEMPT`: in another region the accepter side of a peering carries no tags until the accepter resource tags it, after the accept (V, lab 29's release test). The VPC peering accept still meets `VpcFabricNeedsLabTag` on the accepter VPC (and `DenyVpnServer`); the scope check allows `aws_vpc_peering_connection_accepter` and `aws_ec2_transit_gateway_peering_attachment_accepter` only in `AWS_PEER_REGION_LABS`, only through the `secondary` provider, and only for the lab's own peering by reference (the pipeline's headend peering is accepted by `wg-admin-deploy`, A25, unchanged). The account holds no transit gateway but the labs' (preflight 2026-10-16). Reason: otherwise lab 29 could never be accepted.
- **P4 (A113). Batch 4's service-linked roles are made ahead.** `SERVICE_LINKED` gains `ipam` (IPAM makes `AWSServiceRoleForIPAM` at `CreateIpam`), `clientvpn` (`AWSServiceRoleForClientVPN`) and `route53resolver` (V each name); `transitgateway`, `network-firewall`, `globalaccelerator`, `vpc-lattice` and `elasticloadbalancing` are already there. One AWS will not make ahead is only reported (A57). Reason: soa-03's first group failed on a role made at first use.
- **P5 (A114). Lab 20's IPAM is the Free Tier, so its pool is IPv6.** Private IPv4 pools are Advanced Tier only (AWS's IPAM tier table, V on the pricing page in Task 23), so lab 20 makes an IPAM with `tier = "free"` operating only in the session's region, a public-scope IPv6 pool of Amazon-provided contiguous space (`public_ip_source = "amazon"`, `aws_service = "ec2"`, `locale = var.region`) with one `/52` provisioned (`aws_vpc_ipam_pool_cidr`, `netmask_length` only, never a literal `cidr`: BYOIP is never), and gives `vpc-lab` a `/56` from it (`aws_vpc_ipv6_cidr_block_association`, A82: `AssociateVpcCidrBlock` is judged on the lab's own tagged pool, never AWS's untagged `ipv6pool-ec2`); the secondary IPv4 CIDR is the slot's second `/20`, associated without IPAM. `cascade = true` on the IPAM. Reason: the spec's "pool from the slot" needs the paid tier; the IPv6 pool teaches the same IPAM objects for free. This changes §12.2 row 20, reworded in Task 23.
- **P6 (A115). IPv6 "internet" is any global IPv6 range** (carried from batch 1 Task 2 / final Minor 4). `fromInternet` counts every IPv6 CIDR outside `fc00::/7` and `fe80::/10` as from the internet (rule `public`: SSH, and the lab-22 router's rule), IPv6 routes stay `::/0` only, and a managed prefix list's entries are IPv4 inside the slot or `var.gateway_cidr` (no IPv6 entries). Reason: `2000::/3` is the whole IPv6 internet and passed as private.
- **P7 (A116). Every service-principal Allow names its source** (carried batch 2 Task 3 M-6). In every resource policy the scope check reads (`RESOURCE_POLICIES`, inline policies, and batch 4's Lattice auth policies), an `Allow` to an AWS service principal must carry `aws:SourceAccount` equal to the plan's account, or `aws:SourceArn` (any case, `ArnEquals`/`ArnLike`/`StringEquals`) in the plan's account. Every existing lab already does (soa-01, soa-08, soa-09, saa-13 read 2026-10-16). Reason: a service acting for another account could otherwise use the lab's bucket or topic (the confused deputy).
- **P8 (A117). Vended logs go to the lab's own bucket, never to CloudWatch Logs.** Route 53 Resolver query logs (lab 23), Network Firewall alert logs (lab 27) and lab 28's second flow log deliver to `cloudlabs-<name_prefix>-*` buckets, each with an explicit bucket policy for `delivery.logs.amazonaws.com` carrying `aws:SourceAccount` (P7); a `cloud-watch-logs` (or Firehose) destination on them is refused (rule `lingering`). `wg-admin-labs` is denied `logs:PutResourcePolicy` and `logs:DeleteResourcePolicy` (added to `DenyAccountAndBilling`): CloudWatch's vended delivery writes an account-wide, untagged logs resource policy that outlives every lab. A VPC flow log to a lab log group through a lab role (soa-08's pattern) stays allowed. The S3 delivery itself is `logs:CreateLogDelivery` (with its Get, Update, Delete and List), allowed by `LabServices`' `logs:*`, and the delivery reads the lab bucket's own policy under `LabBuckets` (Task 2's cases). Each bucket policy grants exactly its lab's delivery path: lab 23's query logs `AWSLogs/<account>/*`, lab 27's alert logs under the `alerts` prefix (`alerts/AWSLogs/<account>/*`), lab 28's Hive-style flow logs `AWSLogs/aws-account-id=<account>/*`. Reason: no lab may leave or change an account-wide setting.
- **P9 (A118). Lab 26's edge.** Global Accelerator's endpoints are two internet-facing Network Load Balancers without security groups (London and Ireland), with `client_ip_preservation_enabled = false`: an EC2 instance endpoint makes Global Accelerator create network interfaces and a per-VPC `GlobalAccelerator` security group in the lab VPC, untagged, which A48 forbids the role to delete and whose removal AWS does not document (AWS "Best practices for ENIs and security groups", read 2026-10-16). The accelerator uses the default provider, which signs Global Accelerator in us-west-2 itself (V; fallback: a provider alias with `region = "us-west-2"`, allowed by lint and rule `provider`); the WAF web ACL uses the per-resource `region = "us-east-1"` with `scope = "CLOUDFRONT"`; so lab 26 has two provider blocks, not four. CloudFront has an origin group (London NLB primary, Ireland NLB secondary, failover on 500, 502, 503, 504), a viewer-request CloudFront Function `lab-<id>-headers`, `price_class = "PriceClass_100"` (A66), and the web ACL by reference; the ACL holds `AWSManagedRulesCommonRuleSet` and one rate-based rule, and refuses AWS's paid managed groups (Bot Control, ATP, ACFP, Anti-DDoS) and any other vendor. Reason: everything lab 26 makes is tagged or named, and deletable by the role. This changes §12.2 row 26 ("Global Accelerator to instances") and §7.4, reworded in Task 23.
- **P10 (A119). Edge tear-down order and retries** (carried batch 2 final review M-4). The safety net retries a CloudFront disable that failed on each later pass until `UNTIL`; deletes CloudFront functions (found by name `lab-<id>-*`, each with its ETag) only after the distributions; deletes the WAF web ACL (CLOUDFRONT, us-east-1, with its lock token) only after them; and takes Global Accelerator apart as AWS requires: disable, wait until `DEPLOYED` and disabled, endpoint groups, listeners, then the accelerator, all in us-west-2.
- **P11 (A120). Lab 22's "on-prem" router.** Ubuntu Server 24.04 arm64 from the public parameter `/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id` (strongSwan and FRR come from Ubuntu's archive; Amazon Linux has no FRR), a `t4g.micro`, an Elastic IP (public by nature, §7.4, `PUBLIC_INSTANCE_LABS`), `source_dest_check = false`; its security group admits UDP 500 and 4500 only from the two tunnel outside addresses, by reference to the lab's own VPN connection, and SSH only from the lab's Instance Connect Endpoint. The pre-shared keys are `random_password` values (alphanumeric, 32) written into the router's user data (A12's reasoning). The tunnels' inside CIDRs are left unset: AWS picks each `/30` from `169.254.0.0/16` and the router's user data reads the chosen addresses from the connection (`lab-lint`'s `literal-cidr` refuses any written range but `0.0.0.0/0` and `::/0`, and no lint exception is made for one lab). BGP: the virtual private gateway on Amazon's ASN 64512, the customer gateway on 65001. The router's AMI is the one instance off the AL2023 parameter, which `commonAwsProblems` accepts only in `PUBLIC_INSTANCE_LABS` (Task 3). `enable_acceleration`, `PrivateIpv4` outside addresses and a transit gateway target are refused (accelerated VPN and Direct Connect are readme-only, §12.2).
- **P12 (A121). Lab 23's hybrid DNS.** A cloud VPC (`vpc-lab`) and an "on-prem" VPC peered by the lab itself; `dnsmasq` on AL2023 (V: the package is in AL2023's repository) at a fixed address answers `corp.<name_prefix>.internal` and forwards `cloud.<name_prefix>.internal` to the inbound endpoint's two fixed addresses; one outbound endpoint and a `FORWARD` rule for `corp.<name_prefix>.internal` to dnsmasq, associated with `vpc-lab`; a private zone `cloud.<name_prefix>.internal` (A88); DNS Firewall blocks `example.com` and `*.example.com` in `vpc-lab` (NXDOMAIN); query logs to the lab's bucket (P8). Resolver rules forward only `*.internal` names to an address in the slot; `SYSTEM` and `RECURSIVE` rules are refused. Reason: forwarding a real domain could steer the lab's own lookups of AWS's names.
- **P13 (A122). PrivateLink stays in the account.** An endpoint service allows only the plan's account root (`arn:aws:iam::<account>:root`), `acceptance_required = false`, no `private_dns_name` (it needs a public domain's TXT record) and no `supported_regions` but the session's; an interface or Gateway Load Balancer endpoint names an AWS service in its own region (`com.amazonaws.<region>.<service>`) or the lab's own endpoint service's `service_name` by reference, never another account's `com.amazonaws.vpce.*` service. Lab 24's "private DNS" is a private zone `svc.<name_prefix>.internal` with an alias to the endpoint (A88) and the S3 gateway endpoint's policy (A100).
- **P14 (A123). Lab 25's load balancers.** One VPC: an internet-facing ALB on HTTP (redirect) and HTTPS with a certificate imported to ACM from `tls` (a self-signed CA and a server certificate for `app.<name_prefix>.internal`, RSA 2048), a weighted forward (blue 80, green 20) and a `/green/*` rule; an internet-facing NLB with one Elastic IP subnet mapping, a TLS listener on the same certificate and a TCP listener on 8080 to a proxy-protocol-v2 target group; a Gateway Load Balancer with a GENEVE target group on a `t4g.small` appliance that builds AWS's open-source `aws-gateway-load-balancer-tunnel-handler` at boot through the lab's NAT gateway (V: build time inside `deploy_min`; the ready check does not wait for it), its endpoint service and one GWLB endpoint inspecting a client subnet's internet traffic. ACM certificates are import-only (`domain_name` and `certificate_authority_arn` refused).
- **P15 (A124). Transit gateways stay in the lab.** Attachments only of the lab's own VPCs and subnets by reference; at most 4 VPC attachments per transit gateway (rule `size`); `auto_accept_shared_attachments = "disable"`; no Connect, multicast, policy tables, `transit_gateway_cidr_blocks` or route-table announcements (`never`); routes to the slot or `0.0.0.0/0` through the lab's own attachments, or blackhole; `appliance_mode_support` only on a lab attachment; a peering attachment only to the lab's own transit gateway in the session's secondary region (`AWS_PEER_REGION_LABS`), `peer_account_id` unset or the plan's account.
- **P16 (A125). Lab 27's Network Firewall.** One subnet mapping (rule `size`, §7.3), delete, subnet-change and policy-change protection all false (rule `lingering`; Unblock already turns delete protection off), rule groups of capacity at most 100, a stateless group forwarding to the stateful engine with one drop rule (ICMP from spoke B to spoke A), a stateful domain allow-list (`.amazonaws.com`, `.amazon.com`, `.ubuntu.com`) on HTTP host and TLS SNI, its `HOME_NET` the slot, with `rule_order = "STRICT_ORDER"` in both the rule group and the policy (AWS takes `stateful_default_actions` only under strict order) and the default actions `aws:drop_established` and `aws:alert_established` (so dropped flows reach the alert log), alert logs to the lab's bucket (P8); TLS inspection configurations are `never`. Firewall Manager stays readme-only (§12.2).
- **P17 (A126). Lab 28's faults and its mirror.** The two faults are §12.2's, verbatim (A28): the service's security group admits TCP 80 only from the NLB subnets, though client IP preservation delivers client addresses; the service subnet's network ACL drops return traffic to the client VPC's range. The Instance Connect Endpoint sits in the service subnet (A75's reasoning). The traffic mirror target is the monitor instance's primary interface by reference and the filter accepts TCP 80 both ways (`ec2:CreateTrafficMirrorFilterRule` joins `CREATE_TAG_EXEMPT`: the provider's filter rule takes no tags, yet AWS asks the request tag of the rule it makes; the rule sits in the lab's own tagged filter, by reference, Task 4); the mirror **session** is a Thing to try made by hand with the lab tag (Traffic Mirroring on `t4g` sources is V). Flow logs go to the lab's log group through a lab role and to the lab's bucket (P8) with an Athena table (`aws_glue_catalog_table` with partition projection in `lab_<id>`; A97's workgroup rules).
- **P18 (A127). Lab 29 compares two inter-region paths.** London and Ireland each hold a VPC and a transit gateway; London requests both the transit gateway peering attachment and an inter-region VPC peering (`peer_region = var.secondary_region`), Ireland accepts both through the `secondary` provider (P3); static transit gateway routes on each default route table point at the peering attachment. Ireland's two instances sit in two subnets with their own route tables: London's `/20` is reached through the transit gateway from one and through the VPC peering from the other, and London routes each `/24` back the same way.
- **P19 (A128). Lab 30's VPC Lattice.** One service network with `auth_type = "AWS_IAM"`, two services (`svc-a` in `vpc-lab`, `svc-b` in a second VPC) with instance target groups, the client's VPC associated with its own security group; auth policies are known at plan and allow only the lab's own client role, its ARN built from the caller identity and the role's fixed path and name (`arn:aws:iam::<account>:role/cloudlabs-lab/lab-<id>-client`, so the policy text is known at plan, A42) with `depends_on` the role (`svc-b`'s allows nobody: a Thing to try); the client role's own `vpc-lattice-svcs:Invoke` policy names `arn:aws:vpc-lattice:<region>:<account>:service/*` (known at plan; the auth policies narrow it to the lab's services); targets admit TCP 80 only from Lattice's AWS-managed prefix list. The client signs with `curl --aws-sigv4` from its instance profile, sending `x-amz-content-sha256: UNSIGNED-PAYLOAD` as Lattice asks (V: AL2023's curl supports it and Lattice accepts the header; Task 24 verifies by hand). Lattice resource policies and access-log subscriptions are not on `AWS_TYPES`.
- **P20 (A129). Lab 31's Client VPN.** Mutual certificate authentication only (directory and federated authentication are `never`; Verified Access stays readme-only, §12.2); the CA, server and client certificates come from `tls` (RSA 2048), one ACM import (the server certificate with its CA chain) serving as both `server_certificate_arn` and `root_certificate_chain_arn` (both certificates come from the same CA, as AWS documents); the client CIDR is the `/22` at `cidrsubnet(var.address_space, 4, 15)` (inside the slot, outside every lab VPC); `split_tunnel = true`, one target network association (rule `size`), one authorisation rule to the lab VPC's CIDR, connection logging off, `self_service_portal = "disabled"`. The `files` output (P2) holds `ans-31.ovpn` (the endpoint's name with `remote-random-hostname`, the CA, the client certificate and key inline), `client.crt` and `client.key`.
- **P21 (A130). Batch 4's tag waits.** A 20-second `time_sleep` sits between a create and its first tag-checked change on each service not yet proven: Lattice (target group → `RegisterTargets`; service and service network → `PutAuthPolicy`), Route 53 Resolver (rule → association; domain list and rule group → firewall rule; query log config → association) and Network Firewall (firewall → logging configuration). EC2's transit gateway, VPN, Client VPN, IPAM and mirroring tags are read at once (EC2, proven). If a release test still fails with `AccessDenied` on such a change, Task 24's fallback adds the service to `TAG_LAG_NAMED` with its `lab-*` name pattern (every such batch 4 item is named `lab-<id>-*`).
- **P22 (A131). Batch 4's diagram kinds.** The kinds batch 1 made for batch 4 are used as they are (transit gateway, VPN gateway and connection, customer gateway, Client VPN, Lattice, Network Firewall and policy, Global Accelerator, CloudFront, WAF, Resolver endpoint and rule, endpoint service, egress-only gateway as `internetGateway`), each already with a sprite icon; IPAM, prefix lists, traffic mirroring, ACM certificates and Glue tables are `generic` cards. Attachments, transit gateway route tables, rule associations, Lattice listeners, target groups and associations fold into their parents. `arnParts` names a WAF ACL `wafv2:global/webacl` and a Lattice listener `vpc-lattice:listener`. Adding sprite icons for batch 3's generic cards is carried again.
- **P23 (A132). Batch 4's clean-up order and states.** As §8.2, with three additions the real APIs need: a VPC endpoint service's own connected endpoints, then the service, go **before** load balancers (AWS refuses to delete a load balancer an endpoint service names); Resolver rule and query-log associations and DNS Firewall rules are found through their parents (they carry no tags); IPAM goes last in phase 4 with `--cascade` (its pools, scopes and provisioned CIDRs with it). Verify clean counts a transit gateway, attachment, route table, VPN connection, virtual private gateway, customer gateway, Client VPN endpoint or IPAM `deleting` or `deleted` as clean (nothing can stop them; the tagging API keeps listing them); Network Firewall, Resolver endpoints and Lattice associations are waited for until not found by the safety net (a VPC cannot go before them).
- **P24 (A133). The Worker reads us-west-2 for Global Accelerator labs.** The resources panel and the live diagram add one tagging call in us-west-2 for `AWS_GA_LABS`; `AWS_TOPOLOGY_CALLS_MAX` rises 15 → 16 (10 London, 4 Ireland, 1 us-east-1, 1 us-west-2: lab 26 has all four); the global groups are labelled by what the lab has there (`lab-ans-26-edge (global: CloudFront, WAF)`, `(global: Global Accelerator)`).
- **P25 (A134). Lab files in the modal.** Under **Show**, an AWS lab's `files` list one row per file with a **Download** button (a `Blob`, `text/plain`, the file's own name, the object URL revoked at once); nothing is cached, Hide and close forget them. `npm run bundle-size` must pass unchanged (no new dependency).
- **P26 (A135). What batch 4 carries and why.** Unblock's Lambda network-interface wait stays in Unblock (no batch 4 Lambda runs in a VPC); the Spot quota read (`L-34B43A08`) stays carried (the AWS feeds' call budget is still full); batch 3's whole-branch minors 1, 2, 3, 5, 6 and 12 are done in Tasks 3–4 where they cost one rule each (5 and 6), and carried with a reason otherwise (Carried forward table).

## Review Focus

1. **A peering accept never reaches past the lab**: the role may accept a peering whose accepter side is untagged, but never into the VPN server's or the default VPC, and the scope check allows an accepter only for the lab's own peering, through the `secondary` provider, in lab 29. Tests: Task 2 "Review Focus 1 / P3: an untagged accepter side is accepted in a lab VPC; never into a VPC without the lab tag or the VPN server's" and Task 3 "Review Focus 1 / P3: an accepter of someone else's peering, outside lab 29 or through the default provider is refused; peer_region only to the secondary".
2. **Every new reference stays in the lab**: transit gateway attachments and routes, VPN gateways and customer gateways, Resolver rules and their targets, endpoint services' principals and endpoints' services, accelerator endpoints, Lattice targets and auth policies, mirror targets, Client VPN networks and certificates, CloudFront origins, functions and ACLs. Tests: Task 4 "Review Focus 2: refuses an attachment, route, gateway, rule, endpoint, accelerator, auth policy, mirror target or Client VPN piece that names anything not the lab's own" and "refsOf resolves references inside nested blocks: ip_address.N.subnet_id, config.0.vpc_identifier, target.0.id, authentication_options.0.root_certificate_chain_arn".
3. **Nothing account-wide or public leaks**: no CloudWatch vended-logs policy (role deny and scope), every service-principal Allow names its source, IPv6 global ranges count as the internet, the lab-22 router admits only its own tunnels, paid WAF groups and accelerated VPN are refused. Tests: Task 2 "ruling P8: logs resource policies are denied; ruling P4: batch 4's service-linked roles", Task 3 "rulings P6 and P7: a global IPv6 range is the internet; a service-principal Allow without its source is refused", Task 4 "rulings P8, P9 and P11: vended logs to CloudWatch, a paid WAF group, an open router and an accelerated VPN are refused".
4. **Tear-down of every new type with no Terraform state, across four regions**: Global Accelerator taken apart in us-west-2, the WAF ACL after CloudFront, an endpoint service's endpoints before it and both before load balancers, VPN connections before gateways, attachments before transit gateways, Network Firewall and Resolver endpoints waited for before the VPC, IPAM cascaded last. Tests: Task 5 "Review Focus 4: Global Accelerator is disabled, waited for, emptied and deleted in us-west-2; the WAF ACL goes after CloudFront", "Review Focus 4: Resolver's associations, rules, firewall rules and endpoints in order", Task 6 "Review Focus 4: endpoint services and their endpoints go before load balancers", "Review Focus 4: VPN connections, gateways, attachments, route tables, then transit gateways", "Review Focus 4: Network Firewall is waited for until gone; IPAM is cascaded after the fabric; Client VPN networks go first".
5. **Lab 31's files reach Steven's PC and nowhere else**: never in `LAB_RESULT`, outputs, a session row or the live log; refused for any other lab; returned only by the secret route while running; cleared at session end; downloadable from the modal. Tests: Task 7 "Review Focus 5 / P2: files are stored on the run, returned only by secret while running, and cleared at session end", "P2: files for another lab, a destroy, a failed deploy, too many or too large are refused", Task 7's workflow test "ruling P2: step 16 sends files only beside the result, for a succeeded deploy or test, never in LAB_RESULT or outputs", Task 9 "Review Focus 5 / P25: Show lists each file with a Download button; Hide forgets them".

---

## File map

| Path | Status | Task |
|---|---|---|
| `scripts/lib/labs.mjs`, `shared/labs.ts`, `infra/ci/lab-parse.sh` (`AWS_DNS_LABS` tuple), `infra/ci/lab-scope-aws.mjs` and `infra/ci/lab-lint.mjs` (contract copies only) | modify | 1 |
| `scripts/test/labs-aws-contract.test.mjs`, `scripts/test/lab-aws-pipeline.test.mjs`, `scripts/test/lab-scope-aws.test.mjs` (constants test), `worker/test/labs-shared.test.ts` | modify | 1 |
| `scripts/lib/aws-lab-policies.mjs`, `scripts/lib/aws-bootstrap-labs.mjs`, `infra/aws-bootstrap/{lab-abac,lab-policies}.json` (generated), `scripts/test/aws-labs-iam.test.mjs` | modify | 2 |
| `infra/ci/lab-scope-aws.mjs`, `infra/ci/lab-lint.mjs` | modify | 3, 4 |
| `scripts/test/fixtures/labs/aws-content.mjs` (`amiProblems`), `scripts/test/labs-aws-template.test.mjs` | modify | 3 |
| `scripts/test/fixtures/labs/plans/{extract-computed.mjs,computed.json,schema-facts.json}` (regenerated), `scripts/test/{lab-scope-aws,lab-lint}.test.mjs` | modify | 3, 4 |
| `infra/ci/lab-aws-safety-net.sh`, `scripts/test/lab-aws-cleanup.test.mjs`, `scripts/test/aws-labs-iam.test.mjs` (CLI-coverage lists) | modify | 5, 6 |
| `infra/ci/lab-unblock-aws.sh`, `infra/ci/lab-ready-aws.sh`, `scripts/test/lab-aws-pipeline.test.mjs` | modify | 6 |
| `worker/migrations/0025_lab_files.sql` | create | 7 |
| `worker/src/demo/schema.gen.ts` (regenerated), `worker/src/labs/{callbacks,settle,store}.ts`, `worker/src/api/labs.ts`, `shared/api.ts` (`LabSecretResponse.files`), `.github/workflows/lab-aws.yml` (step 16), `worker/test/{labs-callbacks,labs-read,labs-aws-files}.test.ts`, `worker/test/labs-helpers.ts` (an `ans-31-client-vpn` test lab), `scripts/test/lab-aws-workflow.test.mjs` | modify / create (`labs-aws-files.test.ts`) | 7 |
| `worker/src/labs/{awsReads,resources,awsTopology}.ts`, `worker/test/{labs-aws-reads,topology-aws}.test.ts` | modify | 8 |
| `web/src/views/labs/RunningLab.tsx`, `web/src/views/labs/labs.css`, `web/src/views/labs/running.test.tsx` | modify | 9 |
| `shared/topology/rules/awsPlanned.ts`, `shared/topology/{kinds,awsLive}.ts`, `worker/test/topology-aws.test.ts` | modify | 10 |
| `labs/ans-20-vpc-design/**`, `labs/_learning/ans-20-vpc-design.yaml`, `shared/topology/planned/ans-20-vpc-design.json`, `shared/guides/ans-20-vpc-design/**`, `scripts/test/fixtures/labs/plans/labs/ans-20-vpc-design.mjs`, `scripts/test/labs-aws-ans-20.test.mjs` | create | 11 |
| the same seven paths for `ans-21-transit-gateway` … `ans-31-client-vpn` | create | 12–22 |
| `shared/guides/{index,placement}.json`, `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts` | modify | 11–22 |
| `docs/superpowers/specs/2026-10-15-aws-labs-design.md` (§17 A110–A135; §4 lab 26's providers; §7.1 service-linked list; §7.4 GA's NLBs) | modify | 23 |
| `docs/labs/release-tests.md`, `scripts/test/fixtures/labs/plans/shapes/ans-*.json`, the labs' plan fixtures | modify | 24 |

## Order and dependencies

Tasks run one at a time, in number order. Engine tasks (1–10) come before the labs that need them (11–22); the gate (23) and the ship (24) are the controller's.

| Task | Title | Depends on |
|---|---|---|
| 1 | Contract: `AWS_FILES_LABS`, `AWS_GA_LABS` and `readsUsWest2`, `AWS_PEER_REGION_LABS`, two DNS labs | – |
| 2 | ABAC and IAM: peering accepts, logs resource policies, batch 4's service-linked roles, simulator and evaluator cases | – |
| 3 | Lint and scope I: batch 4's types, regions and `never` list; IPv6 internet; service principals; the `files` output | 1 |
| 4 | Scope II: batch 4's references, sizes and lingering (`batch4Problems`) | 3 |
| 5 | Clean-up I: edge, DNS and Lattice (Global Accelerator, WAF, CloudFront functions, Resolver, Lattice), Verify states | 2 |
| 6 | Clean-up II: network services (Client VPN, Network Firewall, endpoint services, mirroring, VPN, transit gateways, IPAM, ACM), Unblock, ready check | 5 |
| 7 | Worker: lab files (migration 0025, callback, secret, clear) and lab-aws.yml step 16 | 1 |
| 8 | Worker: us-west-2 reads, WAF and Lattice ARNs, a four-region diagram's budget | 1 |
| 9 | Web: lab files under Show with Download buttons | 7 |
| 10 | Topology: batch 4's types on the planned and live diagrams | 8 |
| 11 | Lab ans-20-vpc-design | 2, 3, 4, 6, 10 |
| 12 | Lab ans-21-transit-gateway | 2, 3, 4, 6, 10 |
| 13 | Lab ans-22-s2s-vpn | 2, 3, 4, 6, 10 |
| 14 | Lab ans-23-hybrid-dns | 1, 2, 3, 4, 5, 10 |
| 15 | Lab ans-24-privatelink | 1, 2, 3, 4, 6, 10 |
| 16 | Lab ans-25-load-balancing | 2, 3, 4, 6, 10 |
| 17 | Lab ans-26-edge | 1, 2, 3, 4, 5, 8, 10 |
| 18 | Lab ans-27-network-firewall | 2, 3, 4, 6, 10 |
| 19 | Lab ans-28-flow-logs-fix | 2, 3, 4, 6, 10 |
| 20 | Lab ans-29-multi-region | 1, 2, 3, 4, 6, 10 |
| 21 | Lab ans-30-vpc-lattice | 2, 3, 4, 5, 10 |
| 22 | Lab ans-31-client-vpn | 1, 2, 3, 4, 6, 7, 9, 10 |
| 23 | Full gate (vitest run explicitly), price and link checks, V answers, spec rulings, PR and whole-branch review (controller) | 1–22 |
| 24 | Ship: spend check, bootstrap preview then apply, merge, migrate and deploy, release tests 20–31, leftovers, record, recalibrate (controller) | 23 |

---

## Lab design sheet (binding on the lab tasks)

Every lab task (11–22) builds exactly what its block says: the ids, names, types, counts, regions, addresses and costs here are decisions, not suggestions. A lab task that finds one impossible stops and reports; it never improvises a name, a type outside `AWS_TYPES` or a region.

**Shared by all twelve** (from batches 1–3, unchanged):
- Folder `labs/<id>/{lab.yaml, readme.md, terraform/}`; `terraform/` holds the template's `versions.tf` (aws, archive, random, time, tls pinned; A60), `main.tf` (the resource group `lab-<id>`), `network.tf` **copied unchanged** (`vpc-lab` at `cidrsubnet(var.address_space, 2, 0)` tagged `cloudlabs-peer = hub`, `snet-private-1/2` = `cidrsubnet(local.vpc_cidr, 4, 0/1)` in two AZs, `rt-private`, `vpce-s3`, `sg-eice` (name `lab-eice`), `eice-lab`), `variables.tf` (only the variables the lab uses), `outputs.tf` (`private_ips`, `connect`, `peer_vpc_id` = `aws_vpc.lab.id`, `peer_route_table_ids`), plus the lab's own files named below.
- Every further VPC is another `/20` of the slot, `cidrsubnet(var.address_space, 2, n)` with `n` as given; its subnets are `/24`s `cidrsubnet(<vpc cidr>, 4, k)`. `subnets_used` counts the `/20`s the lab takes (ruling 56).
- Instances: AL2023 arm64 from `data.aws_ssm_parameter.al2023_arm64` (in Ireland its twin `data.aws_ssm_parameter.al2023_ireland`, the same parameter under `provider = aws.secondary`, labs 26 and 29; Ubuntu only in lab 22; `commonAwsProblems` holds all three through Task 3's `amiProblems`), IMDSv2 required, `volume_tags = merge(var.tags, { Name = "<vm name>" })`, `user_data` from `local.cloud_init_base` (the labadmin user, A12) plus, where a page is served, a systemd unit `lab-web.service` running `python3 -m http.server 80 --directory /srv/www` with an `index.html` naming the instance. No public IPv4 (lab 22's router is the one exception, P11). Each instance's security group admits TCP 22 from its VPC's EICE security group and, where the VPN server can reach it once peered (an instance the peered route tables lead to), TCP 22 and 80 from `var.gateway_cidr` (A45); lab 26's instances (never peered) and lab 28's service VPC (no route back to the gateway) admit nothing from it (controller ruling, plan assembly).
- Each extra VPC with instances has its own S3 gateway endpoint `vpce-s3-<vpc>` on its route table(s) and, where reached by console SSH, its own EICE `eice-<vpc>` with `sg-eice-<vpc>` (name `lab-eice-<vpc>`, egress TCP 22 to that VPC's CIDR); at most two EICEs per lab (§4).
- Connect lines (outline below names only what differs): one `aws ec2-instance-connect ssh --instance-id <id> --os-user labadmin --connection-type eice` per instance reached by console, and while peered `ssh labadmin@<hub instance address>` and `curl http://<hub instance address>`.
- `lab.yaml` cost items: London list prices × 0.75, `whole_hours: true` on every hourly item AWS bills by the started hour (A20, V each), `region: secondary` on items in Ireland. Filters marked (V) are proved or made authored-only by `labs-verify --aws-prices` in Task 23 Step 2. The planning tier stays §12.2's (A21) where the estimate differs.
- Shared price references (exactly as batch 3 writes them): t4g.nano `0.0035`, t4g.micro `0.0071`, t4g.small `0.0141` — `{ service: AmazonEC2, unit: Hrs, filters: { instanceType: <type>, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }`; gp3 root 8 GiB `0.0008` — `{ service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }`; in Ireland (`region: secondary`, labs 26 and 29, the same filters priced in eu-west-1 and checked by `labs-verify --aws-prices`, Task 23 Step 2) t4g.nano `0.0034`, gp3 8 GiB `0.0007`, NLB `0.0189`; NAT gateway `0.0375` — `{ service: AmazonEC2, unit: Hrs, filters: { productFamily: "NAT Gateway", usagetype: "{usage}-NatGateway-Hours" } }`; public IPv4 `0.0038` — `{ service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }`; ALB `0.0199` — `{ service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Application", usagetype: "{usage}-LoadBalancerUsage" } }`; interface endpoint per AZ `0.0083` — `{ service: AmazonVPC, unit: Hrs, filters: { productFamily: VpcEndpoint, usagetype: "{usage}-VpcEndpoint-Hours" } }`.
- New price references (V each, Task 23): NLB `0.0198` — `{ service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Network", usagetype: "{usage}-LoadBalancerUsage" } }`; GWLB `0.0103` — `{ service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Gateway", usagetype: "{usage}-LoadBalancerUsage" } }`; transit gateway attachment `0.0375` — `{ service: AmazonVPC, unit: Hrs, filters: { usagetype: "{usage}-TransitGateway-Hours" } }`; VPN connection `0.0375` — `{ service: AmazonVPC, unit: Hrs, filters: { usagetype: "{usage}-VPN-Usage-Hours:ipsec.1" } }`; Resolver endpoint interface `0.0938` — `{ service: AmazonRoute53, unit: Hrs, filters: { usagetype: "{usage}-ResolverNetworkInterface" } }`; Network Firewall endpoint `0.2963` — `{ service: AWSNetworkFirewall, unit: Hrs, filters: { usagetype: "{usage}-Endpoint-Hour" } }`; GWLB endpoint `0.0075` — `{ service: AmazonVPC, unit: Hrs, filters: { usagetype: "{usage}-VpcEndpoint-GWLBE-Hours" } }`. Authored only (no regional hourly product): Global Accelerator's fixed fee, WAF, CloudFront, VPC Lattice services, Client VPN, IPAM, data and request charges.
- The release test checks deploy, ready, (peer and unpeer when the server runs in AWS), destroy and a clean Verify; it never checks that a lab's traffic works, so a broken path (lab 28's faults, lab 22's tunnels before the router's BGP comes up) never fails it.

---

### Lab 20 — `ans-20-vpc-design` (Task 11)

- **Title:** "VPC design: dual stack, IPAM, prefix lists, egress". **Areas** `[ans.design, ans.implementation]`; level `associate`; type `explore`; tier £ (0.05); peering `optional`; timing `{ deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 4 }`; prerequisites `[]`.
- **Regions/providers:** London only; the default provider.
- **Files:** template set + `ipam.tf`, `dual.tf`, `compute.tf`.
- **Types and counts:** template (`aws_resourcegroups_group` 1, `aws_vpc` 1, `aws_subnet` 2, `aws_route_table` 1, `aws_route_table_association` 2, `aws_vpc_endpoint` 1, `aws_security_group` 1, `aws_vpc_security_group_egress_rule` 1, `aws_ec2_instance_connect_endpoint` 1); `ipam.tf`: `aws_vpc_ipam` 1 (`ipam-lab`; `tier = "free"`, `operating_regions { region_name = var.region }`, `cascade = true`), `aws_vpc_ipam_pool` 1 (`pool-v6`; `address_family = "ipv6"`, `ipam_scope_id = aws_vpc_ipam.lab.public_default_scope_id`, `locale = var.region`, `public_ip_source = "amazon"`, `aws_service = "ec2"`), `aws_vpc_ipam_pool_cidr` 1 (`netmask_length = 52`), `aws_vpc_ipv6_cidr_block_association` 1 (`vpc_id = aws_vpc.lab.id`, `ipv6_ipam_pool_id`, `ipv6_netmask_length = 56`, `depends_on` the pool CIDR); `dual.tf`: `aws_vpc_ipv4_cidr_block_association` 1 (`cidr_block = cidrsubnet(var.address_space, 2, 1)`), `aws_subnet` 3 (`snet-dual-1/2` = `cidrsubnet(<secondary>, 4, 0/1)` with `ipv6_cidr_block = cidrsubnet(<vpc /56>, 8, 0/1)` and `assign_ipv6_address_on_creation = true`; `snet-public` = `cidrsubnet(<secondary>, 4, 2)` with IPv6 `cidrsubnet(<vpc /56>, 8, 2)`), `aws_internet_gateway` 1 (`igw-lab`), `aws_egress_only_internet_gateway` 1 (`eigw-lab`), `aws_eip` 1 (`eip-nat`), `aws_nat_gateway` 1 (`nat-lab`, in `snet-public`), `aws_route_table` 2 (`rt-public`: `0.0.0.0/0` and `::/0` → `igw-lab`; `rt-dual`: `0.0.0.0/0` → `nat-lab`, `::/0` → `eigw-lab`), `aws_route` 4, `aws_route_table_association` 3, `aws_ec2_managed_prefix_list` 1 (name `lab-<id>-admin`, Name `pl-admin`, IPv4, `max_entries = 4`, entries `var.gateway_cidr` "the WireGuard server's VPC" and `local.vpc_cidr` "vpc-lab primary"), `aws_vpc_security_group_egress_rule` 1 more on `sg-eice` (TCP 22 to the secondary `/20`); `compute.tf`: `aws_security_group` 1 (`sg-dual`, name `lab-dual`), `aws_vpc_security_group_ingress_rule` 3 (TCP 22 and TCP 80 from the prefix list by `prefix_list_id`; TCP 22 from `sg-eice`), `aws_vpc_security_group_egress_rule` 2 (all to `0.0.0.0/0` and `::/0`), `aws_instance` 1 (`vm-dual`, t4g.nano, `snet-dual-1`, `ipv6_address_count = 1`, page served on `--bind ::`).
- **Reach:** EICE `eice-lab` (vpc-lab, so the extra egress rule reaches the secondary CIDR); AL2023 t4g.nano (no comparison of architectures). `peer_route_table_ids = [rt-private, rt-dual]`.
- **Rulings:** P5, P6, A11 (vm-dual reaches packages through `nat-lab`; `vpce-s3` stays on `rt-private`), A45, A82 (association on the lab's own pool).
- **Ready:** `vm-dual` running with both checks ok; `nat-lab` available; EICE create-complete (IPAM, pool, prefix list and EIGW ready by existing).
- **Connect:** EICE to `vm-dual`; "IPv6: <vm-dual's IPv6>" (from `ipv6_addresses[0]`); peered ssh/curl to `vm-dual`'s IPv4.
- **Cost items:** NAT `0.0375` (whole); public IPv4 (NAT) `0.0038`; t4g.nano `0.0035`; gp3 8 GiB `0.0008`; `{ name: "IPAM Free Tier, an Amazon-provided IPv6 pool", gbp_h: 0 }`; `{ name: "Egress-only internet gateway and prefix list", gbp_h: 0 }`; EICE `0`. ≈ £0.046/h. `capacity.instance_types: [t4g.nano]`; `subnets_used: 2`; `identity.creates: []`.
- **Release test:** ≈ £0.04 (one NAT hour).
- **(V):** the Free Tier provisions an Amazon-provided `/52` to a public-scope pool and the provider 6.69 has `tier`; how long the provision and the deprovision take (inside 5/5, else raise `deploy_min`/`destroy_min` with a version bump, Task 24); `AssociateVpcCidrBlock` from the pool on an existing VPC passes the ABAC (Task 2's case).

### Lab 21 — `ans-21-transit-gateway` (Task 12)

- **Title:** "Transit Gateway: segmentation and central egress". **Areas** `[ans.design, ans.implementation]`; `expert`; `explore`; ££ (0.17); `optional`; `{ deploy_min: 8, destroy_min: 8, session_h: 2, max_h: 4 }`; prerequisites `[ans-20-vpc-design]`.
- **Regions/providers:** London; default provider.
- **Files:** template set + `spoke-b.tf`, `egress.tf`, `tgw.tf`, `compute.tf`.
- **Types and counts:** template; `spoke-b.tf`: `aws_vpc` (`vpc-spoke-b`, n = 1), `aws_subnet` 2 (`snet-spoke-b-1/2`), `aws_route_table` (`rt-spoke-b`), associations 2, `aws_vpc_endpoint` (`vpce-s3-spoke-b`), `aws_security_group` (`sg-eice-spoke-b`) + egress rule, `aws_ec2_instance_connect_endpoint` (`eice-spoke-b`); `egress.tf`: `aws_vpc` (`vpc-egress`, n = 2), `aws_subnet` 3 (`snet-egress-tgw-1/2` k = 0/1, `snet-egress-public` k = 2), `aws_internet_gateway` (`igw-egress`), `aws_eip` (`eip-nat`), `aws_nat_gateway` (`nat-egress`), `aws_route_table` 2 (`rt-egress-tgw`: `0.0.0.0/0` → NAT; `rt-egress-public`: `0.0.0.0/0` → IGW, `var.address_space` → TGW), associations 3; `tgw.tf`: `aws_ec2_transit_gateway` 1 (`tgw-lab`; `default_route_table_association` and `_propagation` `"disable"`, `auto_accept_shared_attachments = "disable"`, `dns_support = "enable"`), `aws_ec2_transit_gateway_vpc_attachment` 3 (`tgwa-spoke-a` on `snet-private-1/2`, `tgwa-spoke-b`, `tgwa-egress` on `snet-egress-tgw-1/2` with `appliance_mode_support = "enable"`; each `transit_gateway_default_route_table_association = false`, `…_propagation = false`), `aws_ec2_transit_gateway_route_table` 2 (`tgw-rt-spokes`, `tgw-rt-egress`), `aws_ec2_transit_gateway_route_table_association` 3, `aws_ec2_transit_gateway_route_table_propagation` 2 (both spokes into `tgw-rt-egress`), `aws_ec2_transit_gateway_route` 2 (`tgw-rt-spokes`: `0.0.0.0/0` → `tgwa-egress`; spoke B's `/20` `blackhole = true`), `aws_route` 3 (`rt-private` and `rt-spoke-b`: `0.0.0.0/0` → TGW; `rt-egress-public` slot → TGW); `compute.tf`: `aws_security_group` 2 (`sg-vms-a`, `sg-vms-b`; ICMP and TCP 80 from the slot), rules, `aws_instance` 2 (`vm-a` in `snet-private-1`, `vm-b` in `snet-spoke-b-1`, t4g.nano).
- **Reach:** `eice-lab` (spoke A), `eice-spoke-b`. Hub: `vpc-lab` (spoke A); `peer_route_table_ids = [rt-private]` (the gateway's `/16` is more specific than the default route to the TGW).
- **Rulings:** P15, A45, A57 (`transitgateway` already made ahead).
- **Ready:** TGW and the 3 attachments `available`; NAT `available`; instances; EICEs.
- **Connect:** EICE to `vm-a` and `vm-b`; peered ssh/curl to `vm-a`.
- **Cost items:** TGW attachment `0.0375` × 3 (whole, V); NAT `0.0375` (whole); public IPv4 `0.0038`; t4g.nano × 2; gp3 × 2; `{ name: "Transit Gateway data processing, light test traffic", gbp_h: 0.0005 }`; EICE × 2 `0`. ≈ £0.163/h. `instance_types: [t4g.nano, t4g.nano]`; `subnets_used: 3`; `creates: []`.
- **Release test:** ≈ £0.16.
- **(V):** the attachment price filter; attachment create and delete times inside 8/8.

### Lab 22 — `ans-22-s2s-vpn` (Task 13)

- **Title:** "Site-to-site VPN with BGP to a pretend data centre". **Areas** `[ans.implementation, ans.operations, ans.design]`; `expert`; `explore`; £ (0.05); `optional`; `{ deploy_min: 12, destroy_min: 10, session_h: 2, max_h: 3 }`; prerequisites `[ans-20-vpc-design]`.
- **Regions/providers:** London; default provider.
- **Files:** template set + `onprem.tf`, `vpn.tf`, `router.tf`, `compute.tf`.
- **Types and counts:** template; `onprem.tf`: `aws_vpc` (`vpc-onprem`, n = 1), `aws_subnet` (`snet-onprem`, k = 0, `map_public_ip_on_launch = false`), `aws_internet_gateway` (`igw-onprem`), `aws_route_table` (`rt-onprem`: `0.0.0.0/0` → IGW; `local.vpc_cidr` → the router's primary interface by `network_interface_id`), association, `aws_vpc_endpoint` (`vpce-s3-onprem`), `aws_security_group` (`sg-eice-onprem`) + rule, `aws_ec2_instance_connect_endpoint` (`eice-onprem`); `vpn.tf`: `aws_vpn_gateway` (`vgw-lab`, `vpc_id = aws_vpc.lab.id`, `amazon_side_asn = 64512`), `aws_vpn_gateway_route_propagation` (`rt-private`), `aws_customer_gateway` (`cgw-onprem`, `bgp_asn = 65001`, `ip_address = aws_eip.router.public_ip`, `type = "ipsec.1"`), `random_password` 2 (`psk1`, `psk2`; length 32, `special = false`, `numeric = false`), `aws_vpn_connection` (`vpn-lab`; `type = "ipsec.1"`, `static_routes_only = false`, the tunnel inside CIDRs left unset (AWS picks each tunnel's `/30` from `169.254.0.0/16`; `lab-lint`'s `literal-cidr` refuses a written one, P11), both pre-shared keys, `tunnel*_ike_versions = ["ikev2"]`, tunnel logs off); `router.tf`: `aws_eip` (`eip-router`), `aws_eip_association` (to `vm-router`), `aws_security_group` (`sg-router`, name `lab-router`: UDP 500 and 4500 from `"${aws_vpn_connection.lab.tunnel1_address}/32"` and tunnel 2's; TCP 22 from `sg-eice-onprem`; egress all), its rules, `aws_instance` (`vm-router`, Ubuntu 24.04 arm64 from `data.aws_ssm_parameter.ubuntu_arm64` = `/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id`, t4g.micro, `snet-onprem`, `private_ip = cidrhost(<snet-onprem>, 10)`, `source_dest_check = false`; its cloud-init makes `labadmin` in group `sudo` (Ubuntu has no `wheel`), installs `strongswan-swanctl` and `frr`, writes `/etc/swanctl/conf.d/aws.conf` (two VTI tunnels, the PSKs, the outside addresses and the inside addresses AWS chose, read from the connection's `tunnel1_cgw_inside_address`, `tunnel1_vgw_inside_address` and tunnel 2's) and `/etc/frr/frr.conf` (BGP 65001, neighbours the two VGW inside addresses, ASN 64512, advertising `vpc-onprem`'s `/20`), enables IP forwarding and both services); `compute.tf`: `aws_security_group` (`sg-aws`: ICMP and TCP 80 from `vpc-onprem`'s `/20`), `aws_instance` (`vm-aws`, AL2023 t4g.nano, `snet-private-1`).
- **Reach:** `eice-lab` to `vm-aws`; `eice-onprem` to `vm-router`. Hub `vpc-lab`; `peer_route_table_ids = [rt-private]`.
- **Rulings:** P11, §7.4 (`PUBLIC_INSTANCE_LABS`), A12, A45; "Not built here": Direct Connect (VIFs, LAG, MACsec, gateway, SiteLink) and accelerated VPN.
- **Ready:** VPN connection `available` (tunnels may be down until the router's BGP comes up); VGW ready by existing; instances; EICEs.
- **Connect:** EICE to `vm-aws` and `vm-router`; "On vm-router: sudo swanctl --list-sas; sudo vtysh -c 'show ip bgp summary'"; peered ssh/curl to `vm-aws`.
- **Cost items:** VPN connection `0.0375` (whole, V); public IPv4 (router) `0.0038`; t4g.micro `0.0071`; t4g.nano `0.0035`; gp3 × 2; EICE × 2 `0`; `{ name: "VPN data out, light test traffic", gbp_h: 0.0001 }`. ≈ £0.054/h. `instance_types: [t4g.micro, t4g.nano]`; `subnets_used: 2`; `creates: []`.
- **Release test:** ≈ £0.05.
- **(V):** the Ubuntu parameter path; `strongswan-swanctl` and `frr` on 24.04 arm64; the VPN connection's create time (inside 12); tunnels up within minutes of boot (a Thing to try, never the test).

### Lab 23 — `ans-23-hybrid-dns` (Task 14)

- **Title:** "Hybrid DNS with Route 53 Resolver". **Areas** `[ans.design, ans.implementation, ans.security]`; `expert`; `explore`; ££ (0.38); `optional`; `{ deploy_min: 8, destroy_min: 8, session_h: 2, max_h: 3 }`; prerequisites `[ans-20-vpc-design]`. In `AWS_DNS_LABS` (P1).
- **Regions/providers:** London; default provider (the private zone is signed for us-east-1 by it, A65).
- **Files:** template set + `onprem.tf`, `resolver.tf`, `dnsfw.tf`, `querylog.tf`, `compute.tf`.
- **Types and counts:** template; `onprem.tf`: `aws_vpc` (`vpc-onprem`, n = 1), `aws_subnet` (`snet-onprem-1`), `aws_route_table` (`rt-onprem`), association, `aws_vpc_endpoint` (`vpce-s3-onprem`), `sg-eice-onprem` + rule, `eice-onprem`, `aws_vpc_peering_connection` (`pcx-cloud-onprem`, `auto_accept = true`), `aws_route` 2 (each VPC's `/20` → the peering); `resolver.tf`: `aws_security_group` (`sg-resolver`: UDP/TCP 53 in from `vpc-onprem`'s `/20`, out to `vm-dns`'s `/32`), rules, `aws_route53_resolver_endpoint` 2 (`lab-<id>-in`, INBOUND, fixed `ip`s `cidrhost(snet-private-1, 10)` and `cidrhost(snet-private-2, 10)`; `lab-<id>-out`, OUTBOUND, fixed `.11`s; both `protocols = ["Do53"]`), `aws_route53_resolver_rule` (`lab-<id>-corp`, `FORWARD`, `domain_name = "corp.${var.name_prefix}.internal"`, `target_ip { ip = local.dns_ip, port = 53 }`), `time_sleep` (`resolver_tags`, 20 s, P21), `aws_route53_resolver_rule_association` (`vpc-lab`), `aws_route53_zone` (`cloud.<name_prefix>.internal`, `vpc { vpc_id = aws_vpc.lab.id, vpc_region = var.region }`, `force_destroy = true`), `aws_route53_record` (`app` A → `vm-cloud`); `dnsfw.tf`: `aws_route53_resolver_firewall_domain_list` (`lab-<id>-blocked`, `["example.com.", "*.example.com."]`), `aws_route53_resolver_firewall_rule_group` (`lab-<id>-dnsfw`), `aws_route53_resolver_firewall_rule` (`block`, `BLOCK`, `NXDOMAIN`, priority 100; after the wait), `aws_route53_resolver_firewall_rule_group_association` (`lab-<id>-dnsfw`, `vpc-lab`, priority 101, `mutation_protection = "DISABLED"`); `querylog.tf`: `aws_s3_bucket` (`cloudlabs-<name_prefix>-dnslogs`, `force_destroy = true`), `aws_s3_bucket_public_access_block`, `aws_s3_bucket_policy` (P7/P8: `delivery.logs.amazonaws.com` `s3:PutObject` on `AWSLogs/<account>/*` and `s3:GetBucketAcl`, each with `aws:SourceAccount`), `aws_route53_resolver_query_log_config` (`lab-<id>-queries`, `destination_arn` the bucket), `aws_route53_resolver_query_log_config_association` (`vpc-lab`, after the wait); `compute.tf`: `aws_security_group` 2 (`sg-cloud`, `sg-dns`: UDP/TCP 53 from the slot), `aws_instance` 2 (`vm-cloud` t4g.nano `snet-private-1`; `vm-dns` t4g.nano `snet-onprem-1`, `private_ip = local.dns_ip = cidrhost(snet-onprem-1, 10)`, cloud-init `dnf install -y dnsmasq` with `address=/app.corp.<prefix>.internal/<dns_ip>` and `server=/cloud.<prefix>.internal/<inbound .10s>`).
- **Reach:** `eice-lab`, `eice-onprem`. Hub `vpc-lab`; `peer_route_table_ids = [rt-private]`.
- **Rulings:** P8, P12, P21, A88 (`*.internal`), A87 (us-east-1 listing).
- **Ready:** both endpoints `OPERATIONAL`; instances; EICEs.
- **Connect:** EICE to `vm-cloud` and `vm-dns`; "From vm-cloud: dig app.corp.<prefix>.internal"; peered ssh/curl to `vm-cloud`.
- **Cost items:** Resolver endpoint interface `0.0938` × 4 (whole, V; two per endpoint, AWS's minimum); t4g.nano × 2; gp3 × 2; `{ name: "Route 53 private hosted zone ($0.50 a month)", gbp_h: 0.0005 }`; `{ name: "DNS Firewall and Resolver queries, light test traffic", gbp_h: 0.0001 }`; `{ name: "Query logs to S3, a few kB", gbp_h: 0.0001 }`; EICE × 2. ≈ £0.383/h. `instance_types: [t4g.nano, t4g.nano]`; `subnets_used: 2`; `creates: []`.
- **Release test:** ≈ £0.38 (four interface-hours).
- **(V):** `dnsmasq` in AL2023's repository; the Resolver interface price filter and whole-hour billing; whether Resolver needs `AWSServiceRoleForRoute53Resolver` (made ahead, P4).
- **Known risk (noted, not designed out):** the endpoints' fixed `.10`/`.11` in `snet-private-1` can meet the address AWS gave the template's `eice-lab`, which is made alongside and cannot be ordered after them (`network.tf` is unchanged): about 1 deploy in 125 fails with the address in use (every other ENI in those subnets is the lab's own and `depends_on` the endpoints, and `eice-onprem` follows `vm-dns`). The fallback, if a release test or a session meets it: AWS-chosen endpoint addresses (no `ip` in the `ip_address` blocks; dnsmasq's `server=` lines read `[for a in aws_route53_resolver_endpoint.inbound.ip_address : a.ip]`), version 2.

### Lab 24 — `ans-24-privatelink` (Task 15)

- **Title:** "PrivateLink: endpoints and endpoint services". **Areas** `[ans.design, ans.implementation, ans.security, saa.secure]`; `expert`; `explore`; £ (0.05); `optional`; `{ deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 4 }`; prerequisites `[ans-20-vpc-design]`. In `AWS_DNS_LABS` (P1).
- **Regions/providers:** London; default provider.
- **Files:** template set + `provider-vpc.tf`, `service.tf`, `consumer.tf`, `iam.tf`, `compute.tf`.
- **Types and counts:** template; `provider-vpc.tf`: `aws_vpc` (`vpc-provider`, n = 1), `aws_subnet` 2 (`snet-provider-1/2`), `aws_route_table` (`rt-provider`), associations 2, `vpce-s3-provider`, `sg-eice-provider` + rule, `eice-provider`; `service.tf`: `aws_lb` (`nlb-<name_prefix>`, internal, network, both provider subnets), `aws_lb_target_group` (`tg-<name_prefix>`, TCP 80, `preserve_client_ip = "false"`), `aws_lb_target_group_attachment`, `aws_lb_listener` (TCP 80), `aws_vpc_endpoint_service` (`vpces-lab`; `acceptance_required = false`, `network_load_balancer_arns`, `allowed_principals = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]`); `consumer.tf`: `aws_security_group` (`sg-endpoint`: TCP 80 from `local.vpc_cidr`), `aws_vpc_endpoint` (`vpce-svc`, Interface, `service_name = aws_vpc_endpoint_service.lab.service_name`, `snet-private-1`, `private_dns_enabled = false`), `aws_route53_zone` (`svc.<name_prefix>.internal`, `vpc-lab`), `aws_route53_record` (`app`, alias to the endpoint's first DNS entry), `aws_vpc_endpoint_policy` (on `vpce-s3`: the lab's `cloudlabs-<name_prefix>-data` and `al2023-repos-<region>-*`, A100), `aws_s3_bucket` (`cloudlabs-<name_prefix>-data`, `force_destroy`), `aws_s3_bucket_public_access_block`, `aws_s3_object` (`hello.txt`); `iam.tf`: `aws_iam_role` (`lab-<id>-consumer`, ec2 trust, boundary), `aws_iam_policy` (`lab-<id>-s3-read`: `s3:GetObject`, `s3:ListBucket` on the data bucket), `aws_iam_role_policy_attachment`, `aws_iam_instance_profile` (`lab-<id>-consumer`); `compute.tf`: `aws_security_group` 2 (`sg-consumer`; `sg-provider`: TCP 80 from the provider `/20`), `aws_instance` 2 (`vm-consumer` `snet-private-1` with the profile; `vm-provider` `snet-provider-1`).
- **Reach:** `eice-lab`, `eice-provider`. Hub `vpc-lab`; `peer_route_table_ids = [rt-private]`.
- **Rulings:** P13, A88, A100, A68/P7.
- **Ready:** NLB `active`; `vpce-svc` `available`; instances; EICEs.
- **Connect:** EICE to both; "From vm-consumer: curl http://app.svc.<prefix>.internal"; "aws s3 cp s3://cloudlabs-<prefix>-data/hello.txt -"; peered ssh/curl to `vm-consumer`.
- **Cost items:** NLB `0.0198` (whole, V); `{ name: "NLB capacity units, light test traffic", gbp_h: 0.0045 }`; interface endpoint, one AZ `0.0083` (whole); t4g.nano × 2; gp3 × 2; private zone `0.0005`; EICE × 2. ≈ £0.045/h. `instance_types: [t4g.nano, t4g.nano]`; `subnets_used: 2`; `creates: [role]`.
- **Release test:** ≈ £0.03.
- **(V):** none beyond the NLB filter.

### Lab 25 — `ans-25-load-balancing` (Task 16)

- **Title:** "Load balancing in depth: ALB, NLB and GWLB". **Areas** `[ans.design, ans.security]`; `expert`; `explore`; £ (0.13); `optional`; `{ deploy_min: 10, destroy_min: 8, session_h: 2, max_h: 3 }`; prerequisites `[soa-03-auto-scaling]`.
- **Regions/providers:** London; default provider; `tls`.
- **Files:** template set + `subnets.tf`, `certs.tf`, `alb.tf`, `nlb.tf`, `gwlb.tf`, `compute.tf`.
- **Types and counts:** template; `subnets.tf` (all in `vpc-lab`): `aws_subnet` 5 (`snet-public-1/2` k = 2/3, AZ a/b; `snet-appliance` k = 4, `snet-gwlbe` k = 5, `snet-inspected` k = 6, AZ a), `aws_internet_gateway` (`igw-lab`), `aws_eip` 2 (`eip-nat`, `eip-nlb`), `aws_nat_gateway` (`nat-lab` in `snet-public-1`), `aws_route_table` 4 (`rt-public`: `0.0.0.0/0` → IGW and `snet-inspected`'s `/24` → `vpce-gwlb`; `rt-appliance` and `rt-gwlbe`: `0.0.0.0/0` → NAT; `rt-inspected`: `0.0.0.0/0` → `vpce-gwlb`), `aws_route` 5, associations 5 (the two public subnets, `snet-appliance`, `snet-gwlbe`, `snet-inspected`); `certs.tf`: `tls_private_key` 2 (`ca`, `server`; RSA 2048), `tls_self_signed_cert` (`ca`, `is_ca_certificate = true`, 168 h), `tls_cert_request` (`server`, CN and `dns_names` `app.<name_prefix>.internal`), `tls_locally_signed_cert` (`server`, `server_auth`, 168 h), `aws_acm_certificate` (`cert-app`, import: `private_key`, `certificate_body`, `certificate_chain`); `alb.tf`: `aws_security_group` (`sg-alb`: TCP 80 and 443 from `0.0.0.0/0`), rules, `aws_lb` (`alb-<name_prefix>`, internet-facing, both public subnets), `aws_lb_target_group` 2 (`tg-<name_prefix>-blue`, `tg-<name_prefix>-green`, HTTP 80), attachments 2, `aws_lb_listener` 2 (`http`: redirect to 443; `https`: `certificate_arn`, `ssl_policy = "ELBSecurityPolicy-TLS13-1-2-2021-06"`, forward weighted blue 80 / green 20), `aws_lb_listener_rule` (`/green/*` → green, priority 10); `nlb.tf`: `aws_security_group` (`sg-nlb`: TCP 443 and 8080 from `0.0.0.0/0`), rules, `aws_lb` (`nlb-<name_prefix>`, internet-facing network, `security_groups = [sg-nlb]`, `subnet_mapping { subnet_id = snet-public-1, allocation_id = eip-nlb }`), `aws_lb_target_group` 2 (`tgn-<name_prefix>-web` TCP 80; `tgn-<name_prefix>-pp` TCP 80 with `proxy_protocol_v2 = true`), attachments 2, `aws_lb_listener` 2 (`tls`: TLS 443 with the certificate → web; `pp`: TCP 8080 → pp); `gwlb.tf`: `aws_lb` (`gwlb-<name_prefix>`, gateway, `snet-appliance`), `aws_lb_target_group` (`tgg-<name_prefix>`, GENEVE 6081, health check HTTP 8080 `/`), attachment, `aws_lb_listener` (default forward), `aws_vpc_endpoint_service` (`vpces-gwlb`, `gateway_load_balancer_arns`, `acceptance_required = false`, own-account root), `aws_vpc_endpoint` (`vpce-gwlb`, GatewayLoadBalancer, `snet-gwlbe`); `compute.tf`: `aws_security_group` 3 (`sg-web`: TCP 80 from `sg-alb` and `sg-nlb`; `sg-appliance`: UDP 6081 and TCP 8080 from `snet-appliance`'s `/24`; `sg-client`), `aws_instance` 4 (`vm-blue` `snet-private-1`, `vm-green` `snet-private-2`, `vm-client` `snet-inspected`, all t4g.nano; `vm-appliance` t4g.small in `snet-appliance`, cloud-init `dnf install -y gcc gcc-c++ cmake make git` (the build needs the C compiler too), clones and builds `aws-gateway-load-balancer-tunnel-handler`, a `gwlbtun.service` whose create and remove hook is the project's own `example-scripts/create-route.sh`, and `python3 -m http.server 8080` for the health check).
- **Reach:** `eice-lab` reaches every instance (one VPC). Hub `vpc-lab`; `peer_route_table_ids = [rt-private]`.
- **Rulings:** P13, P14, §7.4 (internet-facing ALB and NLB), A45.
- **Ready:** the three load balancers `active`; `vpce-gwlb` `available`; NAT; instances (the appliance's build is not waited for).
- **Connect:** EICE to `vm-client` and `vm-appliance`; "ALB: https://<alb dns> (self-signed: curl -k)"; "NLB: <eip-nlb> (TLS 443; proxy protocol 8080)"; peered ssh/curl to `vm-blue`.
- **Cost items:** ALB `0.0199` (whole); `{ name: "ALB capacity units, light test traffic", gbp_h: 0.0060 }`; NLB `0.0198` (whole, V); `{ name: "NLB capacity units, light test traffic", gbp_h: 0.0045 }`; GWLB `0.0103` (whole, V); GWLB endpoint `0.0075` (whole, V); NAT `0.0375` (whole); public IPv4 × 4 (the ALB's 2, NAT, NLB); t4g.small `0.0141`; t4g.nano × 3; gp3 × 4; `{ name: "ACM imported certificate", gbp_h: 0 }`; EICE `0`. ≈ £0.149/h. `instance_types: [t4g.small, t4g.nano, t4g.nano, t4g.nano]`; `subnets_used: 1`; `creates: []`.
- **Release test:** ≈ £0.15.
- **(V):** the tunnel handler's build on AL2023 arm64 (packages, minutes); the GWLB and GWLBE filters; ACM import sends tags in the import call (Task 2's case).

### Lab 26 — `ans-26-edge` (Task 17)

- **Title:** "Edge: CloudFront, WAF and Global Accelerator". **Areas** `[ans.design, ans.security, soa.networking]`; `expert`; `explore`; £ (0.04); peering `off`; `{ deploy_min: 12, destroy_min: 15, session_h: 2, max_h: 3 }`; prerequisites `[soa-09-route53-cloudfront]`. In `AWS_GLOBAL_LABS` (already) and `AWS_GA_LABS`; `regions.secondary: eu-west-1`.
- **Regions/providers:** London (default), Ireland (`aws.secondary`, §4's block, in `ireland.tf`); the WAF ACL `region = "us-east-1"` per resource; Global Accelerator through the default provider (P9). No other provider block.
- **Files:** template set (with `network.tf` unchanged; peering off) + `london.tf`, `ireland.tf`, `accelerator.tf`, `cdn.tf`, `waf.tf`.
- **Types and counts:** template; `london.tf`: `aws_subnet` (`snet-public-1`, k = 2), `aws_internet_gateway` (`igw-lab`), `aws_route_table` (`rt-public`, `0.0.0.0/0` → IGW), `aws_route`, association, `aws_security_group` (`sg-web`: TCP 80 from `0.0.0.0/0`, since a security-group-less NLB keeps clients' addresses; TCP 22 from `sg-eice`), rules, `aws_instance` (`vm-london`, t4g.nano, `snet-private-1`), `aws_lb` (`nlb-<name_prefix>-ldn`, internet-facing network, `snet-public-1`, no security groups), `aws_lb_target_group` (`tg-<name_prefix>-ldn`, TCP 80), attachment, `aws_lb_listener` (TCP 80); `ireland.tf` (all `provider = aws.secondary`): the provider block, `data.aws_availability_zones.ireland`, `data.aws_ssm_parameter.al2023_ireland`, `aws_resourcegroups_group` (`secondary`, `lab-<id>`), `aws_vpc` (`vpc-ireland`, n = 1), `aws_subnet` 2 (`snet-ireland-private` k = 0, `snet-ireland-public` k = 1), `aws_internet_gateway` (`igw-ireland`), `aws_route_table` 2 (`rt-ireland-private`, `rt-ireland-public`), `aws_route`, associations 2, `aws_vpc_endpoint` (`vpce-s3-ireland`), `sg-eice-ireland` + rule, `aws_ec2_instance_connect_endpoint` (`eice-ireland`), `sg-web-ireland` + rules, `aws_instance` (`vm-ireland`, t4g.nano), `aws_lb` (`nlb-<name_prefix>-dub`), `aws_lb_target_group` (`tg-<name_prefix>-dub`), attachment, listener; `accelerator.tf`: `aws_globalaccelerator_accelerator` (`lab-<id>`, `ip_address_type = "IPV4"`, `enabled = true`, `attributes { flow_logs_enabled = false }`), `aws_globalaccelerator_listener` (TCP 80, `client_affinity = "NONE"`), `aws_globalaccelerator_endpoint_group` 2 (`endpoint_group_region = var.region` and `var.secondary_region`; one `endpoint_configuration` each: the NLB's ARN, `weight = 100`, `client_ip_preservation_enabled = false`; health check TCP 80); `cdn.tf`: `aws_cloudfront_function` (`lab-<id>-headers`, `runtime = "cloudfront-js-2.0"`, `publish = true`, adds `x-cloudlabs-edge` to the request), `aws_cloudfront_distribution` (Name `cdn-lab`; origins `london` and `ireland` = the NLBs' DNS names, `custom_origin_config` HTTP-only port 80; `origin_group` `failover` (primary `london`, secondary `ireland`, `failover_criteria { status_codes = [500, 502, 503, 504] }`); default behaviour on the group, GET/HEAD, `redirect-to-https`, the managed CachingDisabled policy as lab 09 names it, `function_association` viewer-request; `price_class = "PriceClass_100"`, `web_acl_id = aws_wafv2_web_acl.lab.arn`, default certificate, `retain_on_delete = false`); `waf.tf`: `aws_wafv2_web_acl` (`lab-<id>-waf`, `region = "us-east-1"`, `scope = "CLOUDFRONT"`, default allow, rule `common` = managed `AWSManagedRulesCommonRuleSet` (vendor AWS, priority 1, `override_action { none {} }`), rule `rate` = rate-based limit 100 per 5 minutes per IP, block, priority 2; visibility metrics on).
- **Reach:** `eice-lab` (London), `eice-ireland`. No peering (`peer_route_table_ids = []` and `connectivity.peering: off`).
- **Rulings:** P1, P9, P10, P24, A65, A66 (price class; origins by reference), A87 (us-east-1 listing of CloudFront and WAF), §7.4 (CloudFront, Global Accelerator, internet-facing NLBs); "Not built here": Shield Advanced.
- **Ready:** both NLBs `active`; accelerator `DEPLOYED`; distribution `Deployed`; instances; EICEs.
- **Connect:** EICE to `vm-london` and `vm-ireland`; "Global Accelerator: curl http://<first static IP>"; "CloudFront: curl -I https://<distribution domain>".
- **Cost items:** `{ name: "Global Accelerator fixed fee ($0.025 an hour)", gbp_h: 0.0188, whole_hours: true }`; `{ name: "Global Accelerator data transfer premium, light test traffic", gbp_h: 0.0005 }`; NLB London `0.0198` (whole); NLB Ireland `0.0189` (whole, `region: secondary`); public IPv4 London and Ireland (the NLBs' one each; Ireland item `region: secondary`); t4g.nano London and Ireland (`region: secondary`); gp3 × 2 (one `region: secondary`); `{ name: "WAF web ACL and 2 rules ($7 a month, prorated hourly)", gbp_h: 0.0072 }`; `{ name: "WAF and CloudFront requests, light test traffic", gbp_h: 0.0002 }`; EICE × 2. ≈ £0.082/h. `instance_types: [t4g.nano, t4g.nano]`; `subnets_used: 2`; `creates: []`; `connectivity: { peering: off, dns_link: false, subnets_used: 2 }`.
- **Release test:** ≈ £0.08 likely; up to ≈ £4.70 if WAF bills a whole month per ACL (V, open concern).
- **(V):** Global Accelerator signed in us-west-2 by the default provider; its tagged accelerator listed by the tagging API in us-west-2; no `GlobalAccelerator` security group or interface appears in either VPC (Task 24 reads `ec2 describe-security-groups --filters Name=group-name,Values=GlobalAccelerator` in both regions); WAF prorated hourly; CloudFront deploy and disable times inside 12/15.

### Lab 27 — `ans-27-network-firewall` (Task 18)

- **Title:** "Network Firewall in an inspection VPC". **Areas** `[ans.security, ans.design]`; `expert`; `explore`; £££ (0.46); `optional`; `{ deploy_min: 15, destroy_min: 15, session_h: 2, max_h: 3 }`; prerequisites `[ans-21-transit-gateway]`.
- **Regions/providers:** London; default provider.
- **Files:** template set + `spoke-b.tf`, `inspection.tf`, `tgw.tf`, `firewall.tf`, `logs.tf`, `compute.tf`.
- **Types and counts:** template; `spoke-b.tf` as lab 21's (`vpc-spoke-b` n = 1, two subnets, `rt-spoke-b`, `vpce-s3-spoke-b`, `eice-spoke-b`); `inspection.tf`: `aws_vpc` (`vpc-inspection`, n = 2), `aws_subnet` 3 (`snet-insp-tgw` k = 0, `snet-insp-firewall` k = 1, `snet-insp-public` k = 2; all AZ a), `aws_internet_gateway` (`igw-inspection`), `aws_eip` (`eip-nat`), `aws_nat_gateway` (`nat-inspection`), `aws_route_table` 3 (`rt-insp-tgw`: `0.0.0.0/0` → firewall endpoint; `rt-insp-firewall`: `0.0.0.0/0` → NAT, slot → TGW; `rt-insp-public`: `0.0.0.0/0` → IGW, slot → firewall endpoint), `aws_route` 5, associations 3; the firewall endpoint is `local.fw_endpoint = one([for s in aws_networkfirewall_firewall.lab.firewall_status[0].sync_states : s.attachment[0].endpoint_id])`; `tgw.tf`: `aws_ec2_transit_gateway` (`tgw-lab`, defaults disabled as lab 21), `aws_ec2_transit_gateway_vpc_attachment` 3 (`tgwa-spoke-a`, `tgwa-spoke-b`, `tgwa-inspection` on `snet-insp-tgw`, `appliance_mode_support = "enable"`), `aws_ec2_transit_gateway_route_table` 2 (`tgw-rt-spokes`, `tgw-rt-inspection`), associations 3, propagations 2 (both spokes into `tgw-rt-inspection`), `aws_ec2_transit_gateway_route` 1 (`tgw-rt-spokes`: `0.0.0.0/0` → `tgwa-inspection`), `aws_route` 2 (both spokes' `0.0.0.0/0` → TGW); `firewall.tf`: `aws_networkfirewall_rule_group` 2 (`lab-<id>-stateless`: STATELESS, capacity 10, priority 1 drop ICMP from spoke B's `/20` to spoke A's, priority 10 forward everything to the stateful engine; `lab-<id>-domains`: STATEFUL, capacity 100, `rules_source_list` ALLOWLIST `[".amazonaws.com", ".amazon.com", ".ubuntu.com"]` on `HTTP_HOST` and `TLS_SNI`, `HOME_NET` = the slot, `stateful_rule_options { rule_order = "STRICT_ORDER" }`), `aws_networkfirewall_firewall_policy` (`lab-<id>-policy`; stateless default and fragment actions `["aws:forward_to_sfe"]`; `stateful_engine_options { rule_order = "STRICT_ORDER" }`, `stateful_default_actions = ["aws:drop_established", "aws:alert_established"]`; both groups by reference, the stateful one with a `priority`), `aws_networkfirewall_firewall` (`lab-<id>`, `vpc-inspection`, one `subnet_mapping` = `snet-insp-firewall`, all three protections `false`), `time_sleep` (`firewall_tags`, 20 s, P21); `logs.tf`: `aws_s3_bucket` (`cloudlabs-<name_prefix>-nfwlogs`), public access block, `aws_s3_bucket_policy` (P7/P8, lab 23's shape on this lab's own path: `s3:PutObject` on `alerts/AWSLogs/<account>/*` and `s3:GetBucketAcl`, each with `aws:SourceAccount`), `aws_networkfirewall_logging_configuration` (ALERT → S3, prefix `alerts`); `compute.tf`: `sg-vms-a`, `sg-vms-b` (ICMP and TCP 80 from the slot), `aws_instance` 2 (`vm-a`, `vm-b`, t4g.nano).
- **Reach:** `eice-lab`, `eice-spoke-b`. Hub `vpc-lab`; `peer_route_table_ids = [rt-private]`.
- **Rulings:** P8, P15, P16, P21; "Not built here": Firewall Manager.
- **Ready:** TGW and attachments `available`; firewall `READY`; NAT; instances; EICEs.
- **Connect:** EICE to `vm-a` and `vm-b`; "From vm-a: curl -sI https://aws.amazon.com (allowed), curl -sI https://example.com (dropped)"; peered ssh/curl to `vm-a`.
- **Cost items:** Network Firewall endpoint `0.2963` (whole, V); `{ name: "Network Firewall traffic processed, light test traffic", gbp_h: 0.0010 }`; TGW attachment `0.0375` × 3 (whole, V); NAT `0.0375` (whole; AWS waives a NAT gateway's hourly charge per firewall endpoint hour, V: the estimate keeps it); public IPv4 `0.0038`; t4g.nano × 2; gp3 × 2; EICE × 2. ≈ £0.459/h. `instance_types: [t4g.nano, t4g.nano]`; `subnets_used: 3`; `creates: []`.
- **Release test:** ≈ £0.47 (one hour of the firewall, the attachments and NAT).
- **(V):** the firewall's price filter and NAT waiver; create and delete times inside 15/15.

### Lab 28 — `ans-28-flow-logs-fix` (Task 19, break-fix)

- **Title:** "Break-fix: flow logs, mirroring and analyzers". **Areas** `[ans.operations, ans.security, soa.networking]`; `expert`; type `break-fix`; £ (0.05); `optional`; `{ deploy_min: 6, destroy_min: 5, session_h: 2, max_h: 4 }`; prerequisites `[soa-08-vpc-fix]`.
- **Regions/providers:** London; default provider.
- **Files:** template set + `service.tf`, `nlb.tf`, `acl.tf`, `flowlogs.tf`, `athena.tf`, `mirror.tf`, `compute.tf`.
- **Faults (built in, verbatim §12.2 and A28):** (1) `sg-svc` admits TCP 80 only from `snet-nlb`'s `/24`, but the target group keeps client IP preservation on (`preserve_client_ip = "true"`), so the client's packets arrive from `vpc-lab` addresses and are dropped, while health checks (from the NLB's own addresses in `snet-nlb`) pass; (2) `acl-svc` on `snet-svc` has an outbound rule 90 `deny` all to `vpc-lab`'s `/20` before rule 100 allowing all, so return traffic to the client range is dropped: flow logs show an ACCEPT inbound and a REJECT outbound record. The readme's Symptom: "From vm-client, `curl http://<nlb>` hangs or fails; the target group shows the target healthy." `What was broken` names both, collapsed.
- **Types and counts:** template (client side: `vpc-lab`); `service.tf`: `aws_vpc` (`vpc-service`, n = 1), `aws_subnet` 2 (`snet-nlb` k = 0, `snet-svc` k = 1, AZ a), `aws_route_table` (`rt-service`), associations 2, `vpce-s3-service`, `aws_vpc_peering_connection` (`pcx-client-service`, `auto_accept = true`), `aws_route` 2 (each side's `/20` → the peering), `aws_security_group` (`sg-eice-service`) + rule, `aws_ec2_instance_connect_endpoint` (`eice-service`, in `snet-svc`: NACLs never filter inside a subnet, A75); `nlb.tf`: `aws_lb` (`nlb-<name_prefix>`, internal network, `snet-nlb`, no security groups), `aws_lb_target_group` (`tg-<name_prefix>`, TCP 80, `preserve_client_ip = "true"`), attachment (`vm-svc`), `aws_lb_listener` (TCP 80); `acl.tf`: soa-08's NACL pattern (A82): `aws_network_acl` (`acl-svc`, in `vpc-service`), `aws_network_acl_association` (`snet-svc`; its delete moves the subnet back to the default ACL), `aws_network_acl_rule` 3 (ingress 100 allow all from `"0.0.0.0/0"`; egress 90 **deny** all to `local.vpc_cidr` (FAULT 2); egress 100 allow all to `"0.0.0.0/0"`), each with a `# FAULT` or plain comment as soa-08's; `flowlogs.tf`: `aws_cloudwatch_log_group` (`/cloudlabs/<id>/flow`, `retention_in_days = 1`), `aws_iam_role` (`lab-<id>-flowlogs`, `vpc-flow-logs.amazonaws.com` trust with `aws:SourceAccount`), `aws_iam_policy` + attachment, `aws_flow_log` 2 (`flow-service`: `vpc-service`, ALL, cloud-watch-logs through the role; `flow-service-s3`: ALL, `s3` to the bucket, `destination_options { file_format = "plain-text", hive_compatible_partitions = true, per_hour_partition = true }`, `max_aggregation_interval = 60`), `aws_s3_bucket` (`cloudlabs-<name_prefix>-flowlogs`), public access block, `aws_s3_bucket_policy` (P7/P8, lab 23's shape on this lab's Hive-style path: `s3:PutObject` on `AWSLogs/aws-account-id=<account>/*` and `s3:GetBucketAcl`, each with `aws:SourceAccount`); `athena.tf`: `aws_glue_catalog_database` (`lab_ans_28_flow_logs_fix`), `aws_glue_catalog_table` (`vpc_flow_logs`, `EXTERNAL_TABLE`, location `s3://cloudlabs-<name_prefix>-flowlogs/AWSLogs/`, the version-2 columns, partition keys `aws-account-id`, `aws-service`, `aws-region`, `year`, `month`, `day`, `hour` with partition projection parameters), `aws_athena_workgroup` (`lab-<id>-wg`, results `s3://cloudlabs-<name_prefix>-flowlogs/athena/`, cut-off 10 MB, enforced, `force_destroy = true`); `mirror.tf`: `aws_ec2_traffic_mirror_target` (`mirror-monitor`, `network_interface_id = aws_instance.monitor.primary_network_interface_id`), `aws_ec2_traffic_mirror_filter` (`mirror-filter-web`), `aws_ec2_traffic_mirror_filter_rule` 2 (ingress and egress, accept TCP 80, source and destination the slot); `compute.tf`: `aws_security_group` 3 (`sg-client`; `sg-svc` (fault 1); `sg-monitor`: UDP 4789 from `vpc-service`'s `/20`), `aws_instance` 3 (`vm-client` `snet-private-1`; `vm-svc` `snet-svc`; `vm-monitor` `snet-nlb`; all t4g.nano).
- **Reach:** `eice-lab` (client), `eice-service` (service and monitor). Hub `vpc-lab`; `peer_route_table_ids = [rt-private]`.
- **Rulings:** A28, A75, A82, A97, P8, P17; per-use charges in the readme beside the Things to try (Athena per GB scanned; Reachability Analyzer about £0.075 an analysis; Network Access Analyzer per interface).
- **Ready:** NLB `active`; instances; EICEs (flow logs and mirror pieces ready by existing). The test never sends client traffic, so the faults never fail it.
- **Connect:** EICE to `vm-client`, `vm-svc`, `vm-monitor`; "From vm-client: curl http://<nlb dns>"; peered ssh/curl to `vm-client`.
- **Cost items:** NLB `0.0198` (whole, V); NLCU `0.0045` authored; t4g.nano × 3; gp3 × 3; `{ name: "Flow logs to CloudWatch and S3, a few MB", gbp_h: 0.0005 }`; `{ name: "Traffic mirror target and filter (a session is billed per hour, by hand)", gbp_h: 0 }`; EICE × 2. ≈ £0.038/h. `instance_types: [t4g.nano, t4g.nano, t4g.nano]`; `subnets_used: 2`; `creates: [role]`.
- **Release test:** ≈ £0.03.
- **(V):** Traffic Mirroring from a `t4g` source (the session is by hand; the readme names the supported types); the S3 flow log's hive options with the explicit bucket policy.

### Lab 29 — `ans-29-multi-region` (Task 20)

- **Title:** "Multi-region: inter-region TGW peering". **Areas** `[ans.design, ans.implementation]`; `expert`; `explore`; ££ (0.20); `optional`; `{ deploy_min: 15, destroy_min: 12, session_h: 2, max_h: 3 }`; prerequisites `[ans-21-transit-gateway]`. In `AWS_PEER_REGION_LABS`; `regions.secondary: eu-west-1`.
- **Regions/providers:** London (default), Ireland (`aws.secondary` in `ireland.tf`).
- **Files:** template set + `london.tf`, `ireland.tf`, `peering.tf`, `compute.tf`.
- **Types and counts:** template; `london.tf`: `aws_ec2_transit_gateway` (`tgw-london`; default association and propagation enabled), `aws_ec2_transit_gateway_vpc_attachment` (`tgwa-london`, `snet-private-1/2`), `aws_route` 2 on `rt-private` (`snet-ireland-tgw`'s `/24` → TGW; `snet-ireland-pcx`'s `/24` → the VPC peering); `ireland.tf` (`provider = aws.secondary`): the provider block, AZ and AMI data, `aws_resourcegroups_group` (`secondary`), `aws_vpc` (`vpc-ireland`, n = 1), `aws_subnet` 2 (`snet-ireland-tgw` k = 0 AZ a, `snet-ireland-pcx` k = 1 AZ b), `aws_route_table` 2 (`rt-ireland-tgw`: London's `/20` → `tgw-ireland`; `rt-ireland-pcx`: London's `/20` → the peering), `aws_route` 2, associations 2, `vpce-s3-ireland` (on both), `sg-eice-ireland` + rule, `eice-ireland`, `aws_ec2_transit_gateway` (`tgw-ireland`, `amazon_side_asn = 64513`: London keeps 64512, and AWS recommends a unique ASN per peered transit gateway), `aws_ec2_transit_gateway_vpc_attachment` (`tgwa-ireland`, both subnets); `peering.tf`: `aws_ec2_transit_gateway_peering_attachment` (`tgwp-london-ireland`, London, `peer_region = var.secondary_region`, `peer_transit_gateway_id = aws_ec2_transit_gateway.ireland.id`), `aws_ec2_transit_gateway_peering_attachment_accepter` (`secondary`, same Name), `aws_ec2_transit_gateway_route` 2 (London's default route table: Ireland's `/20` → the peering attachment; Ireland's: London's `/20` → it; both `depends_on` the accepter), `aws_vpc_peering_connection` (`pcx-london-ireland`, `peer_region = var.secondary_region`, `peer_vpc_id` Ireland's by reference, `auto_accept = false`), `aws_vpc_peering_connection_accepter` (`secondary`, `auto_accept = true`, Name `pcx-london-ireland`); `compute.tf`: `sg-vms` (London: ICMP and TCP 80 from Ireland's `/20`), `sg-vms-ireland` (from London's `/20`), `aws_instance` 3 (`vm-london` `snet-private-1`; `vm-ireland-tgw` `snet-ireland-tgw`; `vm-ireland-pcx` `snet-ireland-pcx`; all t4g.nano).
- **Reach:** `eice-lab`, `eice-ireland`. Hub `vpc-lab`; `peer_route_table_ids = [rt-private]`.
- **Rulings:** P1, P3, P15, P18, A87 (two regions).
- **Ready:** both TGWs and the three attachments `available` (the peering after its accept); instances; EICEs.
- **Connect:** EICE to all three; "From vm-london: ping <vm-ireland-tgw> (by the TGW), ping <vm-ireland-pcx> (by the peering)"; peered ssh/curl to `vm-london`.
- **Cost items:** TGW attachment London × 2 (the VPC attachment and the peering attachment; whole, V) and Ireland × 2 (`region: secondary`; whole, V: whether AWS bills the peering attachment on both sides); `{ name: "Inter-region data transfer, light test traffic", gbp_h: 0.0005 }`; t4g.nano London × 1 and Ireland × 2 (`region: secondary`); gp3 × 3; EICE × 2. ≈ £0.163/h. `instance_types: [t4g.nano, t4g.nano, t4g.nano]`; `subnets_used: 2`; `creates: []`.
- **Release test:** ≈ £0.16.
- **(V):** the accepter side's tags (P3's exemption covers either answer); the peering attachment associated with each side's default route table on accept (fallback, written in Task 20: one `aws_ec2_transit_gateway_route_table_association` per side, version 2); the peering attachment's billing; deploy inside 15 (the peering accept takes minutes).

### Lab 30 — `ans-30-vpc-lattice` (Task 21)

- **Title:** "VPC Lattice service network with auth policies". **Areas** `[ans.design, ans.security]`; `expert`; `explore`; £ (0.05); `optional`; `{ deploy_min: 6, destroy_min: 5, session_h: 2, max_h: 4 }`; prerequisites `[ans-24-privatelink]`.
- **Regions/providers:** London; default provider.
- **Files:** template set + `svc-b-vpc.tf`, `iam.tf`, `lattice.tf`, `compute.tf`.
- **Types and counts:** template; `svc-b-vpc.tf`: `aws_vpc` (`vpc-svc-b`, n = 1), `aws_subnet` 2 (`snet-svc-b-1/2`), `aws_route_table` (`rt-svc-b`), associations 2, `vpce-s3-svc-b`, `sg-eice-svc-b` + rule, `eice-svc-b`; `iam.tf`: `aws_iam_role` (`lab-<id>-client`, ec2 trust, boundary), `aws_iam_policy` (`lab-<id>-invoke`: `vpc-lattice-svcs:Invoke` on `arn:aws:vpc-lattice:${var.region}:<account>:service/*`, known at plan, A42), attachment, `aws_iam_instance_profile` (`lab-<id>-client`); `lattice.tf`: `data.aws_ec2_managed_prefix_list.lattice` (`com.amazonaws.${var.region}.vpc-lattice`), `aws_security_group` (`sg-lattice`: TCP 80 in from `local.vpc_cidr`), rule, `aws_vpclattice_service_network` (`lab-<id>-sn`, `auth_type = "AWS_IAM"`), `aws_vpclattice_service` 2 (`lab-<id>-svc-a`, `lab-<id>-svc-b`, both `AWS_IAM`), `aws_vpclattice_target_group` 2 (`lab-<id>-tg-a` in `vpc-lab`, `lab-<id>-tg-b` in `vpc-svc-b`; INSTANCE, HTTP 80, health check `/`), `time_sleep` (`lattice_tags`, 20 s, P21), `aws_vpclattice_target_group_attachment` 2, `aws_vpclattice_listener` 2 (HTTP 80, default forward), `aws_vpclattice_service_network_service_association` 2, `aws_vpclattice_service_network_vpc_association` (`vpc-lab`, `security_group_ids = [sg-lattice]`), `aws_vpclattice_auth_policy` 2 (the network's: Allow `local.client_role_arn` (built from the caller identity and the role's fixed path and name, `depends_on` the role and the wait) `vpc-lattice-svcs:Invoke`; `svc-a`'s: Allow it `GET`; `svc-b` has none, so AWS_IAM refuses everyone: a Thing to try); `compute.tf`: `sg-targets-a`, `sg-targets-b` (TCP 80 from the Lattice prefix list by `prefix_list_id`), `aws_instance` 3 (`vm-client` `snet-private-1` with the profile; `vm-svc-a` `snet-private-2`; `vm-svc-b` `snet-svc-b-1`; all t4g.nano).
- **Reach:** `eice-lab` (client and svc-a), `eice-svc-b`. Hub `vpc-lab`; `peer_route_table_ids = [rt-private]`.
- **Rulings:** P7 (auth policies read as resource policies), P19, P21, §7.2 (`vpc-lattice-svcs` in the boundary).
- **Ready:** both services and both associations of each kind `ACTIVE`; instances; EICEs.
- **Connect:** EICE to `vm-client` and `vm-svc-b`; "svc-a: http://<svc-a DNS name>"; "svc-b: http://<svc-b DNS name>"; peered ssh/curl to `vm-client`. The readme's first Thing to try is the signed `curl --aws-sigv4 "aws:amz:<region>:vpc-lattice-svcs"` with the instance profile's credentials from IMDSv2.
- **Cost items:** `{ name: "VPC Lattice services (2, $0.025 an hour each)", gbp_h: 0.0188, qty: 2 }` (authored, V); `{ name: "Lattice requests and data, light test traffic", gbp_h: 0.0001 }`; t4g.nano × 3; gp3 × 3; EICE × 2. ≈ £0.051/h. `instance_types: [t4g.nano, t4g.nano, t4g.nano]`; `subnets_used: 2`; `creates: [role]`.
- **Release test:** ≈ £0.05.
- **(V):** Lattice's service-hour price; AL2023's curl supports `--aws-sigv4`, and Lattice accepts its signed request with `x-amz-content-sha256: UNSIGNED-PAYLOAD` (Task 24, by hand on `vm-client` during the release test).

### Lab 31 — `ans-31-client-vpn` (Task 22)

- **Title:** "AWS Client VPN with certificates, compared with WireGuard". **Areas** `[ans.implementation, ans.security]`; `expert`; `explore`; £ (0.12); `optional`; `{ deploy_min: 10, destroy_min: 8, session_h: 2, max_h: 3 }`; prerequisites `[]`. In `AWS_FILES_LABS`.
- **Regions/providers:** London; default provider; `tls`.
- **Files:** template set + `certs.tf`, `cvpn.tf`, `compute.tf`; `outputs.tf` adds `files`.
- **Types and counts:** template; `certs.tf`: `tls_private_key` 3 (`ca`, `server`, `client`; RSA 2048), `tls_self_signed_cert` (`ca`, CN "cloudlabs ans-31 CA", 48 h, `cert_signing`, `crl_signing`), `tls_cert_request` 2 (`server`: CN and `dns_names` `server.<name_prefix>.internal`; `client`: CN `client.<name_prefix>.internal`), `tls_locally_signed_cert` 2 (`server`: `server_auth`, `digital_signature`, `key_encipherment`; `client`: `client_auth`, `digital_signature`; 48 h), `aws_acm_certificate` (`cert-cvpn-server`: the server key, certificate and the CA as chain); `cvpn.tf`: `aws_security_group` (`sg-cvpn`, egress all to `local.vpc_cidr`), rule, `aws_ec2_client_vpn_endpoint` (Name `cvpn-lab`, `description = "lab-<id>"`, `server_certificate_arn` = the ACM ARN, `client_cidr_block = cidrsubnet(var.address_space, 4, 15)`, `split_tunnel = true`, `transport_protocol = "udp"`, `vpn_port = 443`, `authentication_options { type = "certificate-authentication", root_certificate_chain_arn = <the same ACM ARN> }`, `connection_log_options { enabled = false }`, `vpc_id`, `security_group_ids = [sg-cvpn]`, `self_service_portal = "disabled"`, `session_timeout_hours = 8`), `aws_ec2_client_vpn_network_association` (`snet-private-1`), `aws_ec2_client_vpn_authorization_rule` (`target_network_cidr = local.vpc_cidr`, `authorize_all_groups = true`); `compute.tf`: `aws_security_group` (`sg-target`: TCP 22, 80 and ICMP from `sg-cvpn`), `aws_instance` (`vm-target`, t4g.nano, `snet-private-1`). `outputs.tf`: `output "files" { sensitive = true, value = { "ans-31.ovpn" = <config>, "client.crt" = <client cert PEM>, "client.key" = <client key PEM> } }`, the `.ovpn` being `client`, `dev tun`, `proto udp`, `remote ${replace(aws_ec2_client_vpn_endpoint.lab.dns_name, "*.", "")} 443`, `remote-random-hostname`, `resolv-retry infinite`, `nobind`, `remote-cert-tls server`, `cipher AES-256-GCM`, `verb 3`, and inline `<ca>`, `<cert>`, `<key>`.
- **Reach:** `eice-lab`; over Client VPN from Steven's PC. Hub `vpc-lab`; `peer_route_table_ids = [rt-private]`; `subnets_used: 2` (the `/20` and the client `/22` in the slot's fourth `/20`).
- **Rulings:** P2, P20, P25, A13; "Not built here": Verified Access. The readme compares Client VPN with cloudlabs' own WireGuard server (per-connection billing, certificates against keys, split tunnel against AllowedIPs).
- **Ready:** the Client VPN endpoint `available` (it leaves `pending-associate` once the association is made); instance; EICE.
- **Connect:** EICE to `vm-target`; "Download ans-31.ovpn under Show, import it into the AWS VPN Client or OpenVPN, then: ssh labadmin@<vm-target>, curl http://<vm-target>"; peered ssh/curl to `vm-target`.
- **Cost items:** `{ name: "Client VPN subnet association ($0.10 an hour)", gbp_h: 0.0750, whole_hours: true }` (authored, V); `{ name: "Client VPN connection while you are connected ($0.05 an hour)", gbp_h: 0.0375 }`; t4g.nano; gp3; `{ name: "ACM imported certificate", gbp_h: 0 }`; EICE `0`. ≈ £0.117/h. `instance_types: [t4g.nano]`; `subnets_used: 2`; `creates: []`.
- **Release test:** ≈ £0.08 (one association hour, no connection).
- **(V):** ACM import sends its tags in the import call; the same ACM ARN accepted as both server and root chain; the `clientvpn` service-linked role name; the endpoint's `dns_name` form; the `.ovpn` connecting from Windows (a Thing to try, never the test).

### Batch totals

| Lab | Release test (likely) | Stream |
|---|---|---|
| ans-24-privatelink | £0.03 | A |
| ans-28-flow-logs-fix | £0.03 | B |
| ans-20-vpc-design | £0.04 | C |
| ans-22-s2s-vpn | £0.05 | A |
| ans-30-vpc-lattice | £0.05 | B |
| ans-26-edge | £0.08 (WAF V) | C |
| ans-31-client-vpn | £0.08 | A |
| ans-25-load-balancing | £0.15 | B |
| ans-21-transit-gateway | £0.16 | C |
| ans-29-multi-region | £0.16 | A |
| ans-23-hybrid-dns | £0.38 | B |
| ans-27-network-firewall | £0.47 | C |
| **Batch** | **≈ £1.70 likely; ≈ £3.40 with one retry each; target ≤ £4** | |

---

### Task 1: Contract: `AWS_FILES_LABS`, `AWS_GA_LABS` and `readsUsWest2`, `AWS_PEER_REGION_LABS`, two DNS labs

Spec: §3.2 (regions), §4 (`files` output), §5 step 1 (Parse payload), §6 (contract and its copies), §8.2 (the regions the safety net lists); rulings A13, A87, P1.

**Files:**
- Modify: `scripts/lib/labs.mjs` and `shared/labs.ts` (`AWS_DNS_LABS` gains two; `AWS_FILES_LABS`, `AWS_GA_LABS`, `readsUsWest2`, `AWS_PEER_REGION_LABS`), `infra/ci/lab-parse.sh` (`AWS_DNS_LABS` tuple), `infra/ci/lab-scope-aws.mjs` (copies of `AWS_DNS_LABS` and `AWS_PEER_REGION_LABS`), `infra/ci/lab-lint.mjs` (a copy of `AWS_FILES_LABS`; Task 3 uses it)
- Test: `scripts/test/labs-aws-contract.test.mjs`, `scripts/test/lab-aws-pipeline.test.mjs`, `scripts/test/lab-scope-aws.test.mjs` (the constants test), `scripts/test/lab-lint.test.mjs`, `worker/test/labs-shared.test.ts`

**Interfaces:**
- Produces: `AWS_FILES_LABS: readonly string[]`, `AWS_GA_LABS: readonly string[]`, `readsUsWest2(id: string): boolean`, `AWS_PEER_REGION_LABS: readonly string[]` in `shared/labs.ts` and `scripts/lib/labs.mjs`. Task 3 reads `AWS_FILES_LABS` (lint) and `AWS_PEER_REGION_LABS` (scope); Task 7 reads `AWS_FILES_LABS` (Worker); Task 8 calls `readsUsWest2`; `LAB_REGIONS` for `ans-23-hybrid-dns` and `ans-24-privatelink` is `eu-west-2 eu-west-1 us-east-1` (Tasks 5, 14, 15 rely on it).

**`scripts/lib/labs.mjs`**, `AWS_DNS_LABS` and after it:
```js
export const AWS_DNS_LABS = ["saa-16-dr-pilot-light", "ans-23-hybrid-dns", "ans-24-privatelink"];
/** Ruling P1 (batch 4): the labs whose Terraform may declare the sensitive `files` output (A13): lab 31's client files. */
export const AWS_FILES_LABS = ["ans-31-client-vpn"];
/** Ruling P1: the labs with Global Accelerator, whose API answers (and whose items are listed) only in us-west-2. */
export const AWS_GA_LABS = ["ans-26-edge"];
/** Whether the Worker reads an AWS lab's tagged items in us-west-2 too. */
export const readsUsWest2 = (id) => AWS_GA_LABS.includes(id);
/** Ruling P1: the labs whose VPC peering and transit gateway peering cross to the session's secondary region. */
export const AWS_PEER_REGION_LABS = ["ans-29-multi-region"];
```
**`shared/labs.ts`**: the same five, typed `readonly string[]` and `(id: string): boolean`, with the same comments. **`infra/ci/lab-parse.sh`**: `AWS_DNS_LABS = ("saa-16-dr-pilot-light", "ans-23-hybrid-dns", "ans-24-privatelink")` (the `LAB_REGIONS` line is unchanged). **`infra/ci/lab-scope-aws.mjs`**: its `AWS_DNS_LABS` copy gains the two ids, and after it `export const AWS_PEER_REGION_LABS = ["ans-29-multi-region"];` (comment "Ruling P1: a copy of the contract's"). **`infra/ci/lab-lint.mjs`**: `export const AWS_FILES_LABS = ["ans-31-client-vpn"];` beside its other AWS constants (same comment).

- [ ] **Step 1: Write the failing tests.**

`scripts/test/labs-aws-contract.test.mjs` (import the new names):
```js
test("ruling P1 (batch 4): the files, Global Accelerator, peer-region and DNS lists; GA labs read us-west-2", () => {
  assert.deepEqual(AWS_FILES_LABS, ["ans-31-client-vpn"]);
  assert.deepEqual(AWS_GA_LABS, ["ans-26-edge"]);
  assert.deepEqual(AWS_PEER_REGION_LABS, ["ans-29-multi-region"]);
  assert.deepEqual(["ans-26-edge", "soa-09-route53-cloudfront", "ans-29-multi-region"].map(readsUsWest2), [true, false, false]);
  assert.ok(AWS_GA_LABS.every((id) => AWS_GLOBAL_LABS.includes(id)), "a GA lab is a global lab (Parse payload lists us-west-2 for it)");
  assert.deepEqual(["ans-23-hybrid-dns", "ans-24-privatelink", "ans-30-vpc-lattice"].map(readsUsEast1), [true, true, false]);
});
```
The existing "lab-parse.sh's AWS_DNS_LABS equals the contract's (ruling P5)" test covers the tuple unchanged.
`scripts/test/lab-aws-pipeline.test.mjs`, beside batch 3's DNS-lab test:
```js
test("ruling P1: lab 23's regions add us-east-1 only; lab 26's add us-east-1 and us-west-2", { skip }, () => {
  const run = (id, more = {}) => parseRun("aws", { ...PAYLOAD, lab_id: id, version: 1, name_prefix: "a23k3x9q", ...more }, { ...LAB, id, version: 1 });
  assert.equal(run("ans-23-hybrid-dns").env.LAB_REGIONS, "eu-west-2 eu-west-1 us-east-1");
  assert.equal(run("ans-26-edge", { secondary_region: "eu-west-1" }).env.LAB_REGIONS, "eu-west-2 eu-west-1 us-east-1 us-west-2");
});
```
`scripts/test/lab-scope-aws.test.mjs`, "the constants equal the contract's copies": import `AWS_PEER_REGION_LABS` from `../lib/labs.mjs` and add `[scope.AWS_PEER_REGION_LABS, AWS_PEER_REGION_LABS]`. `scripts/test/lab-lint.test.mjs`: `assert.deepEqual(lint.AWS_FILES_LABS, contract.AWS_FILES_LABS)` in its constants test (import `* as contract from "../lib/labs.mjs"` if absent). `worker/test/labs-shared.test.ts`: `expect([...scripts.AWS_FILES_LABS]).toEqual([...AWS_FILES_LABS]);` and the same for `AWS_GA_LABS`, `AWS_PEER_REGION_LABS`, `AWS_DNS_LABS`.

- [ ] **Step 2: Run them to make sure they fail**
Run: `node --test scripts/test/labs-aws-contract.test.mjs scripts/test/lab-aws-pipeline.test.mjs scripts/test/lab-scope-aws.test.mjs scripts/test/lab-lint.test.mjs` and `npx vitest run worker/test/labs-shared.test.ts`
Expected: FAIL (no `AWS_FILES_LABS`, `AWS_GA_LABS`, `readsUsWest2`, `AWS_PEER_REGION_LABS`; lab 23's `LAB_REGIONS` lacks us-east-1). The pipeline test skips without bash/Python (CI runs it).

- [ ] **Step 3: Write the changes** above.

- [ ] **Step 4: Run the targeted tests**
Run: the Step 2 commands, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add scripts/lib/labs.mjs shared/labs.ts infra/ci/lab-parse.sh infra/ci/lab-scope-aws.mjs infra/ci/lab-lint.mjs scripts/test/labs-aws-contract.test.mjs scripts/test/lab-aws-pipeline.test.mjs scripts/test/lab-scope-aws.test.mjs scripts/test/lab-lint.test.mjs worker/test/labs-shared.test.ts
git commit -m "feat(aws labs): batch 4 contract: files, Global Accelerator and peer-region labs; labs 23 and 24 list us-east-1

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---

### Task 2: ABAC and IAM: peering accepts, logs resource policies, batch 4's service-linked roles, simulator and evaluator cases

Spec: §7.1 (create and change lists, `ServiceLinkedRoles`, `DenyAccountAndBilling`), §15 (ABAC gaps); rulings A19, A29, A46, A54, A57, A59, A82, A83, P3, P4, P8.

**What the reference says** (Service Authorization Reference, fetched 2026-10-16; every batch 4 create a lab makes, and what else AWS authorises it on, A82):

| Action | Request tag on | Also authorised on (lab-tagged in every batch 4 lab) | List today |
|---|---|---|---|
| `ec2:CreateTransitGateway`, `CreateTransitGatewayRouteTable` | the TGW, the route table | the TGW | create (scoped) |
| `ec2:CreateTransitGatewayVpcAttachment` | the attachment | the TGW, VPC, subnets | create (scoped) |
| `ec2:CreateTransitGatewayPeeringAttachment` | the attachment | the requester TGW | create (scoped) |
| `ec2:AcceptTransitGatewayPeeringAttachment` | – | the attachment, **accepter side: untagged until accepted (V)** | change → **exempt (P3)** |
| `ec2:AcceptVpcPeeringConnection` | – | the peering (accepter side untagged, V) and the accepter VPC | change → **exempt (P3)**; still `VpcFabricNeedsLabTag` |
| `ec2:CreateTransitGatewayRoute`, `AssociateTransitGatewayRouteTable`, `Enable…Propagation` | – | the attachment and route table | change |
| `ec2:CreateVpnGateway`, `CreateCustomerGateway`, `CreateVpnConnection` | each | the VGW, CGW | create (scoped) |
| `ec2:AttachVpnGateway`, `EnableVgwRoutePropagation` | – | the VGW, VPC, route table | change |
| `ec2:CreateClientVpnEndpoint` | the endpoint | the VPC, security group | create (scoped) |
| `ec2:AssociateClientVpnTargetNetwork`, `AuthorizeClientVpnIngress` | – | the endpoint, subnet | change |
| `ec2:CreateIpam`, `CreateIpamPool` | each | the scope (AWS-made at `CreateIpam`, tagged? V: the pool's create is refused only on its own type) | create (scoped) |
| `ec2:ProvisionIpamPoolCidr`, `AssociateVpcCidrBlock` (from a pool) | – | the pool, VPC | change |
| `ec2:CreateEgressOnlyInternetGateway`, `CreateManagedPrefixList`, `CreateVpcEndpointServiceConfiguration`, `CreateTrafficMirror{Target,Filter}` | each | the VPC; a mirror target's interface (refused only on the target's own type) | create (scoped) |
| `ec2:CreateTrafficMirrorFilterRule` | the rule (but the provider's `aws_ec2_traffic_mirror_filter_rule` takes no tags, schema 6.69.1) | the filter | create (scoped) → **exempt (P17)**: `CREATE_TAG_EXEMPT` |
| `ec2:AssociateAddress` (lab 22's router) | – | the Elastic IP, instance | change |
| `route53resolver:Create{ResolverEndpoint,ResolverRule,FirewallDomainList,FirewallRuleGroup,ResolverQueryLogConfig}`, `AssociateFirewallRuleGroup` | the action | – | create |
| `route53resolver:AssociateResolverRule`, `CreateFirewallRule`, `AssociateResolverQueryLogConfig` | – | the rule, list and group, config | change (P21's wait) |
| `network-firewall:CreateFirewall*`, `CreateRuleGroup` | the action | the policy, rule groups | create |
| `network-firewall:UpdateLoggingConfiguration` | – | the firewall | change (P21's wait) |
| `vpc-lattice:Create*` | the action | – | create |
| `vpc-lattice:RegisterTargets`, `PutAuthPolicy` | – | the target group; the service or network | change (P21's wait) |
| `acm:ImportCertificate` | the action | – | create (the provider sends `Tags` in the import, V) |
| `logs:CreateLogDelivery`, `GetLogDelivery`, `UpdateLogDelivery`, `DeleteLogDelivery`, `ListLogDeliveries` (vended logs to S3: labs 23, 27, 28) | – | – | neither list: `LabServices`' `logs:*` in the lab regions (P8) |
| `s3:GetBucketPolicy`, `PutBucketPolicy` on the lab's `cloudlabs-<name_prefix>-*` log buckets (the delivery reads the lab's own policy) | – | the bucket | `LabBuckets` (`s3:*` on `cloudlabs-*`) |
| `wafv2:CreateWebACL` (us-east-1) | the action | managed rule sets carry no tag key | create |
| `globalaccelerator:*`, `cloudfront:*` | not ABAC services (`GlobalServices`, regions us-east-1 and us-west-2) | – | plan-time tag rule only |

**Files:**
- Modify: `scripts/lib/aws-lab-policies.mjs` (`CHANGE_TAG_EXEMPT` gains the two accepts with P3's comment; `CREATE_TAG_EXEMPT` gains `ec2:CreateTrafficMirrorFilterRule` with P17's; `SERVICE_LINKED` gains `ipam`, `clientvpn`, `route53resolver`; `DenyAccountAndBilling` gains `logs:PutResourcePolicy`, `logs:DeleteResourcePolicy`; header names P3, P8)
- Modify: `scripts/lib/aws-bootstrap-labs.mjs` (fifteen simulator cases)
- Regenerate: `infra/aws-bootstrap/lab-abac.json` (`node scripts/aws-labs-abac.mjs`), `infra/aws-bootstrap/lab-policies.json` (`--render`)
- Test: `scripts/test/aws-labs-iam.test.mjs`

**Interfaces:**
- Produces: the regenerated policies (Tasks 5–6's clean-up calls rely on them, proved by the CLI-coverage test); `SERVICE_LINKED` (the bootstrap makes them ahead in Task 24). Labs 20–31 rely on every row above.

**`scripts/lib/aws-lab-policies.mjs`**:
```js
// Ruling P3 (A112): a peering's accepter side carries no lab tag until the accepter resource tags it, after the accept
// (in another region, V: lab 29's release test). The VPC peering accept still meets VpcFabricNeedsLabTag on the
// accepter VPC; lab-scope-aws.mjs allows an accepter only of the lab's own peering, in AWS_PEER_REGION_LABS.
export const CHANGE_TAG_EXEMPT = ["ec2:ReplaceNetworkAclAssociation", "elasticloadbalancing:DeleteLoadBalancer", "ec2:DeleteNetworkInterface", "ec2:AcceptVpcPeeringConnection", "ec2:AcceptTransitGatewayPeeringAttachment"];
```
and `CREATE_TAG_EXEMPT` gains, after `"ec2:CopyImage"`, `"ec2:CreateTrafficMirrorFilterRule"` with the comment `// Ruling P17 (A126): the provider's filter rule takes no tags, yet AWS asks the request tag of the rule it makes; the rule sits in the lab's own tagged filter (lab-scope-aws.mjs: by reference), and DeleteTrafficMirrorFilterRule still needs the lab tag.`
`SERVICE_LINKED` gains, at the end, `"ipam", "clientvpn", "route53resolver"` (ruling P4). In `fixedStatements`, `DenyAccountAndBilling`'s list gains `"logs:PutResourcePolicy", "logs:DeleteResourcePolicy"` with the comment `// Ruling P8: CloudWatch Logs' account-wide resource policy (vended log delivery writes one that outlives every lab).`

**`scripts/lib/aws-bootstrap-labs.mjs`**, `simulatorCases`, after the batch 3 cases and before `...defaultVpcCase(...)`:
```js
    // Batch 4 (labs 20–31).
    { name: "a tagged transit gateway", action: "ec2:CreateTransitGateway", resource: `arn:aws:ec2:eu-west-2:${account}:transit-gateway/*`, context: [region, ...labTag], want: "allowed" },
    { name: "an untagged transit gateway", action: "ec2:CreateTransitGateway", resource: `arn:aws:ec2:eu-west-2:${account}:transit-gateway/*`, context: [region], want: "denied" },
    { name: "accept a peering attachment in Ireland, untagged there", action: "ec2:AcceptTransitGatewayPeeringAttachment", resource: `arn:aws:ec2:eu-west-1:${account}:transit-gateway-attachment/tgw-attach-0123456789abcdef0`, context: [ctx("aws:RequestedRegion", ["eu-west-1"])], want: "allowed" },
    { name: "accept a VPC peering into a lab VPC", action: "ec2:AcceptVpcPeeringConnection", resource: `arn:aws:ec2:eu-west-1:${account}:vpc/vpc-0123456789abcdef0`, context: [ctx("aws:RequestedRegion", ["eu-west-1"]), ...labResourceTag], want: "allowed" },
    { name: "accept a VPC peering into an untagged VPC", action: "ec2:AcceptVpcPeeringConnection", resource: `arn:aws:ec2:eu-west-2:${account}:vpc/vpc-0123456789abcdef0`, context: [region], want: "denied" },
    { name: "accept a VPC peering into the VPN server's VPC", action: "ec2:AcceptVpcPeeringConnection", resource: `arn:aws:ec2:eu-west-2:${account}:vpc/vpc-0123456789abcdef0`, context: [region, ...labResourceTag, ctx("aws:ResourceTag/wg-admin", ["vpn"])], want: "denied" },
    { name: "a tagged Client VPN endpoint", action: "ec2:CreateClientVpnEndpoint", resource: `arn:aws:ec2:eu-west-2:${account}:client-vpn-endpoint/*`, context: [region, ...labTag], want: "allowed" },
    { name: "a tagged Network Firewall", action: "network-firewall:CreateFirewall", resource: `arn:aws:network-firewall:eu-west-2:${account}:firewall/lab-ans-27-network-firewall`, context: [region, ...labTag], want: "allowed" },
    { name: "a Global Accelerator in us-west-2", action: "globalaccelerator:CreateAccelerator", resource: "*", context: [ctx("aws:RequestedRegion", ["us-west-2"])], want: "allowed" },
    { name: "a WAF web ACL for CloudFront in us-east-1", action: "wafv2:CreateWebACL", resource: `arn:aws:wafv2:us-east-1:${account}:global/webacl/lab-ans-26-edge-waf/*`, context: [ctx("aws:RequestedRegion", ["us-east-1"]), ...labTag], want: "allowed" },
    { name: "CloudWatch Logs' account resource policy", action: "logs:PutResourcePolicy", resource: "*", context: [region], want: "denied" },
    { name: "the IPAM service-linked role", action: "iam:CreateServiceLinkedRole", resource: `arn:aws:iam::${account}:role/aws-service-role/ipam.amazonaws.com/AWSServiceRoleForIPAM`, context: [ctx("iam:AWSServiceName", ["ipam.amazonaws.com"])], want: "allowed" },
    { name: "vended log delivery to a lab bucket", action: "logs:CreateLogDelivery", resource: "*", context: [region], want: "allowed" },
    { name: "a lab log bucket's policy", action: "s3:PutBucketPolicy", resource: "arn:aws:s3:::cloudlabs-a23k3x9q-dnslogs", context: [region], want: "allowed" },
    { name: "a mirror filter rule, untagged", action: "ec2:CreateTrafficMirrorFilterRule", resource: `arn:aws:ec2:eu-west-2:${account}:traffic-mirror-filter-rule/*`, context: [region], want: "allowed" },
```
(`labResourceTag` is `[ctx("aws:ResourceTag/cloudlabs-lab", ["ans-29-multi-region"])]`, defined beside `labTag` if the file does not have it.) The test file imports `CREATE_TAG_EXEMPT` beside `CHANGE_TAG_EXEMPT` if it does not already.

- [ ] **Step 1: Write the failing tests** in `scripts/test/aws-labs-iam.test.mjs` (import nothing new):

```js
test("Review Focus 1 / P3: an untagged accepter side is accepted in a lab VPC; never into a VPC without the lab tag or the VPN server's", { skip }, () => {
  const { ABAC, POLICIES } = files();
  const d = (action, resource, ctx) => decide(POLICIES.role, { action, resource, ctx });
  const IE = { "aws:RequestedRegion": "eu-west-1" };
  assert.ok(CHANGE_TAG_EXEMPT.includes("ec2:AcceptVpcPeeringConnection") && CHANGE_TAG_EXEMPT.includes("ec2:AcceptTransitGatewayPeeringAttachment"));
  const coversIt = (x) => (a) => a.toLowerCase() === x.toLowerCase() || (a.endsWith("*") && x.toLowerCase().startsWith(a.slice(0, -1).toLowerCase()));
  for (const x of ["ec2:AcceptVpcPeeringConnection", "ec2:AcceptTransitGatewayPeeringAttachment"]) assert.ok(!ABAC.change.some(coversIt(x)), `no change-list entry covers ${x}`);
  assert.equal(d("ec2:AcceptTransitGatewayPeeringAttachment", `arn:aws:ec2:eu-west-1:${A}:transit-gateway-attachment/tgw-attach-0abc`, IE), "allowed");
  assert.equal(d("ec2:AcceptVpcPeeringConnection", `arn:aws:ec2:eu-west-1:${A}:vpc-peering-connection/pcx-0abc`, IE), "allowed", "the accepter side's peering, untagged");
  assert.equal(d("ec2:AcceptVpcPeeringConnection", `arn:aws:ec2:eu-west-1:${A}:vpc/vpc-0abc`, { ...IE, "aws:ResourceTag/cloudlabs-lab": "ans-29-multi-region" }), "allowed");
  assert.equal(d("ec2:AcceptVpcPeeringConnection", `arn:aws:ec2:eu-west-1:${A}:vpc/vpc-0abc`, IE), "explicitDeny", "VpcFabricNeedsLabTag on the accepter VPC");
  assert.equal(d("ec2:AcceptVpcPeeringConnection", `arn:aws:ec2:eu-west-2:${A}:vpc/vpc-0abc`, { "aws:RequestedRegion": "eu-west-2", "aws:ResourceTag/cloudlabs-lab": "x", "aws:ResourceTag/wg-admin": "vpn" }), "explicitDeny");
  assert.equal(d("ec2:AcceptTransitGatewayVpcAttachment", `arn:aws:ec2:eu-west-2:${A}:transit-gateway-attachment/tgw-attach-0abc`, { "aws:RequestedRegion": "eu-west-2" }), "explicitDeny", "other accepts still need the tag");
});

test("ruling P8: logs resource policies are denied; ruling P4: batch 4's service-linked roles", { skip }, () => {
  const { POLICIES } = files();
  const d = (action, resource, ctx) => decide(POLICIES.role, { action, resource, ctx });
  for (const a of ["logs:PutResourcePolicy", "logs:DeleteResourcePolicy"]) assert.equal(d(a, "*", { "aws:RequestedRegion": "eu-west-2" }), "explicitDeny", a);
  for (const s of ["ipam", "clientvpn", "route53resolver", "transitgateway", "network-firewall", "globalaccelerator", "vpc-lattice"]) assert.ok(SERVICE_LINKED.includes(`${s}.amazonaws.com`), s);
});

test("what labs 20–31 do is allowed: tagged creates, their changes, the global services, the roles they pass, vended log delivery", { skip }, () => {
  const { POLICIES } = files();
  const allowed = (action, resource, ctx) => assert.equal(decide(POLICIES.role, { action, resource, ctx }), "allowed", `${action} on ${resource}`);
  const ec2 = (rest, region = "eu-west-2") => `arn:aws:ec2:${region}:${A}:${rest}`;
  // Lab 20: IPAM, the IPv6 pool, the association, egress-only gateway, prefix list.
  allowed("ec2:CreateIpam", `arn:aws:ec2::${A}:ipam/*`, NEW);
  allowed("ec2:CreateIpamPool", `arn:aws:ec2::${A}:ipam-pool/*`, NEW);
  allowed("ec2:ProvisionIpamPoolCidr", `arn:aws:ec2::${A}:ipam-pool/ipam-pool-0abc`, LAB);
  allowed("ec2:AssociateVpcCidrBlock", ec2("vpc/vpc-0abc"), LAB);
  allowed("ec2:AssociateVpcCidrBlock", `arn:aws:ec2::${A}:ipam-pool/ipam-pool-0abc`, LAB);
  for (const [a, t] of [["ec2:CreateEgressOnlyInternetGateway", "egress-only-internet-gateway"], ["ec2:CreateManagedPrefixList", "prefix-list"]]) allowed(a, ec2(`${t}/*`), NEW);
  // Labs 21, 27, 29: transit gateways.
  for (const [a, t] of [["ec2:CreateTransitGateway", "transit-gateway"], ["ec2:CreateTransitGatewayVpcAttachment", "transit-gateway-attachment"], ["ec2:CreateTransitGatewayRouteTable", "transit-gateway-route-table"], ["ec2:CreateTransitGatewayPeeringAttachment", "transit-gateway-attachment"]]) allowed(a, ec2(`${t}/*`), NEW);
  for (const [a, t] of [["ec2:CreateTransitGatewayRoute", "transit-gateway-route-table/tgw-rtb-0abc"], ["ec2:AssociateTransitGatewayRouteTable", "transit-gateway-attachment/tgw-attach-0abc"], ["ec2:DeleteTransitGateway", "transit-gateway/tgw-0abc"]]) allowed(a, ec2(t), LAB);
  // Lab 22: VPN.
  for (const [a, t] of [["ec2:CreateVpnGateway", "vpn-gateway"], ["ec2:CreateCustomerGateway", "customer-gateway"], ["ec2:CreateVpnConnection", "vpn-connection"]]) allowed(a, ec2(`${t}/*`), NEW);
  for (const [a, t] of [["ec2:AttachVpnGateway", "vpn-gateway/vgw-0abc"], ["ec2:EnableVgwRoutePropagation", "route-table/rtb-0abc"], ["ec2:DeleteVpnConnection", "vpn-connection/vpn-0abc"]]) allowed(a, ec2(t), LAB);
  // Labs 23: Resolver; 27: Network Firewall; 30: Lattice; 25, 31: ACM.
  for (const a of ["route53resolver:CreateResolverEndpoint", "route53resolver:CreateResolverRule", "route53resolver:CreateFirewallDomainList", "route53resolver:CreateFirewallRuleGroup", "route53resolver:CreateResolverQueryLogConfig", "network-firewall:CreateFirewall", "network-firewall:CreateFirewallPolicy", "network-firewall:CreateRuleGroup", "vpc-lattice:CreateServiceNetwork", "vpc-lattice:CreateService", "vpc-lattice:CreateTargetGroup", "acm:ImportCertificate"]) allowed(a, "*", NEW);
  for (const [a, r] of [["route53resolver:AssociateResolverRule", `arn:aws:route53resolver:eu-west-2:${A}:resolver-rule/rslvr-rr-0abc`], ["network-firewall:UpdateLoggingConfiguration", `arn:aws:network-firewall:eu-west-2:${A}:firewall/lab-x`], ["vpc-lattice:RegisterTargets", `arn:aws:vpc-lattice:eu-west-2:${A}:targetgroup/tg-0abc`], ["vpc-lattice:PutAuthPolicy", `arn:aws:vpc-lattice:eu-west-2:${A}:service/svc-0abc`], ["acm:DeleteCertificate", `arn:aws:acm:eu-west-2:${A}:certificate/0abc`]]) allowed(a, r, LAB);
  // Lab 31: Client VPN; lab 28: mirroring and the flow-log role; lab 24, 25: endpoint services.
  allowed("ec2:CreateClientVpnEndpoint", ec2("client-vpn-endpoint/*"), NEW);
  allowed("ec2:AssociateClientVpnTargetNetwork", ec2("client-vpn-endpoint/cvpn-endpoint-0abc"), LAB);
  for (const [a, t] of [["ec2:CreateTrafficMirrorTarget", "traffic-mirror-target"], ["ec2:CreateTrafficMirrorFilter", "traffic-mirror-filter"], ["ec2:CreateVpcEndpointServiceConfiguration", "vpc-endpoint-service"]]) allowed(a, ec2(`${t}/*`), NEW);
  allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-ans-28-flow-logs-fix-flowlogs`, { "iam:PassedToService": "vpc-flow-logs.amazonaws.com" });
  // Ruling P17: the filter rule carries no tags (the provider has none), so it is create-tag exempt; its filter is the lab's.
  assert.ok(CREATE_TAG_EXEMPT.includes("ec2:CreateTrafficMirrorFilterRule"));
  allowed("ec2:CreateTrafficMirrorFilterRule", ec2("traffic-mirror-filter-rule/*"), { "aws:RequestedRegion": "eu-west-2" });
  allowed("ec2:CreateTrafficMirrorFilterRule", ec2("traffic-mirror-filter/tmf-0abc"), LAB);
  // Ruling P8: vended logs (labs 23, 27, 28) to the lab's bucket: the delivery and the bucket's own policy; lab 22's EIP.
  for (const a of ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries"]) allowed(a, "*", { "aws:RequestedRegion": "eu-west-2" });
  for (const a of ["s3:GetBucketPolicy", "s3:PutBucketPolicy"]) allowed(a, "arn:aws:s3:::cloudlabs-a23k3x9q-dnslogs", { "aws:RequestedRegion": "eu-west-2" });
  assert.notEqual(decide(POLICIES.role, { action: "s3:PutBucketPolicy", resource: "arn:aws:s3:::someone-elses-bucket", ctx: { "aws:RequestedRegion": "eu-west-2" } }), "allowed");
  allowed("ec2:AssociateAddress", ec2("elastic-ip/eipalloc-0abc"), LAB);
  // Lab 26: the global services in their regions.
  allowed("globalaccelerator:CreateAccelerator", "*", { "aws:RequestedRegion": "us-west-2" });
  allowed("cloudfront:CreateFunction", "*", { "aws:RequestedRegion": "us-east-1" });
  allowed("wafv2:CreateWebACL", `arn:aws:wafv2:us-east-1:${A}:global/webacl/lab-ans-26-edge-waf/*`, { ...NEW, "aws:RequestedRegion": "us-east-1" });
  assert.notEqual(decide(POLICIES.role, { action: "globalaccelerator:CreateAccelerator", resource: "*", ctx: { "aws:RequestedRegion": "eu-west-2" } }), "allowed", "Global Accelerator answers only in us-west-2 (V)");
});
```

Change the existing tests:
- "the simulator cases are A19's, fix round 1's …": the expected list gains, after `["the Spot service-linked role", "allowed"]` and before `["a subnet in the default VPC", "denied"]`: `["a tagged transit gateway", "allowed"], ["an untagged transit gateway", "denied"], ["accept a peering attachment in Ireland, untagged there", "allowed"], ["accept a VPC peering into a lab VPC", "allowed"], ["accept a VPC peering into an untagged VPC", "denied"], ["accept a VPC peering into the VPN server's VPC", "denied"], ["a tagged Client VPN endpoint", "allowed"], ["a tagged Network Firewall", "allowed"], ["a Global Accelerator in us-west-2", "allowed"], ["a WAF web ACL for CloudFront in us-east-1", "allowed"], ["CloudWatch Logs' account resource policy", "denied"], ["the IPAM service-linked role", "allowed"], ["vended log delivery to a lab bucket", "allowed"], ["a lab log bucket's policy", "allowed"], ["a mirror filter rule, untagged", "allowed"]`; rename it "… batch 3's and batch 4's …".
- "--labs: every simulator case …": `sims.length` 54 → 69.
- "lab-abac.json is the generator's …": the pinned hash becomes the regenerated lists' (the reviewer reads the diff first: the two accepts out of the change list, the `ec2:AcceptTransit*`/`ec2:AcceptVpc*` folds split, anything AWS added since 2026-10-16).
- "ruling P1: 20 policies at most, at least 4 spare, each packed under POLICY_PACK": unchanged (Step 4 must still print at most 16).

- [ ] **Step 2: Run them to make sure they fail**
Run: `node --test scripts/test/aws-labs-iam.test.mjs`
Expected: FAIL (the accepts are change-listed by `ec2:AcceptVpc*`/`ec2:AcceptTransit*`; the untagged mirror filter rule refused; logs resource policies allowed; 54 cases).

- [ ] **Step 3: Change `aws-lab-policies.mjs` and `aws-bootstrap-labs.mjs`** with the code given in this task (the two exemption lists, `SERVICE_LINKED`, `DenyAccountAndBilling`, the fifteen simulator cases).

- [ ] **Step 4: Regenerate the lists and the policies**
Run: `node scripts/aws-labs-abac.mjs && node scripts/aws-labs-abac.mjs --render && node scripts/aws-labs-abac.mjs --check`
Expected: `lab-abac.json` rewritten (fetched 2026-10-1x); `--render` prints "role: N of at most 20 policies" with N ≤ 16 (11 today) and every size under 5,600, no A29 fall-back, and no "covers … which ruling A82 exempts" error (the generator skips exempt actions before folding). If the reference does not answer from this machine, say so and leave both files for the controller (Task 23 Step 1).

- [ ] **Step 5: Run the targeted tests**
Run: `node --test scripts/test/aws-labs-iam.test.mjs`
Expected: PASS (after the hash pin is updated as Step 1 says).

- [ ] **Step 6: Commit**
```bash
git add scripts/lib/aws-lab-policies.mjs scripts/lib/aws-bootstrap-labs.mjs infra/aws-bootstrap/lab-abac.json infra/aws-bootstrap/lab-policies.json scripts/test/aws-labs-iam.test.mjs
git commit -m "feat(aws labs): peering accepts judged by the accepter VPC; mirror filter rules create-tag exempt; no logs resource policies; IPAM, Client VPN and Resolver service-linked roles; batch 4 simulator cases

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---

### Task 3: Lint and scope I: batch 4's types, regions and `never` list; IPv6 internet; service principals; the `files` output

Spec: §4 (providers, `files`), §7.3 (lint; scope rules 1, 4, 5, 10, 11), §7.4, §12.2 "Not built here"; rulings A65, A68, A87, P1–P3, P5–P7, P9, P13, P15, P20.

**Files:**
- Modify: `infra/ci/lab-scope-aws.mjs` (`AWS_TYPES` gains batch 4's; `NEVER_TYPES` gains batch 4's; rule 1's peer-region and accepter clauses; rule 9's two peering clauses held outside `AWS_PEER_REGION_LABS` only; `fromInternet` (P6); `resourcePolicyProblem` (P7) and `RESOURCE_POLICIES` gains `aws_vpclattice_auth_policy`; `DEFERRED` loses `aws_vpc_peering_connection_accepter` (P3 judges it); header)
- Modify: `infra/ci/lab-lint.mjs` (`lintTfText` and `lintDir` take the lab's id; the AWS check `outputs`: a `files` output only in `AWS_FILES_LABS`, with `sensitive = true`; header)
- Modify: `scripts/test/fixtures/labs/aws-content.mjs` (`amiProblems`, called by `commonAwsProblems` in place of its one `ami` line: the Ireland twin and lab 22's Ubuntu parameter, rulings P9, P11, P18)
- Modify: `scripts/test/fixtures/labs/plans/extract-computed.mjs` (`TYPES` gains batch 4's), regenerate `computed.json` and `schema-facts.json`
- Test: `scripts/test/lab-scope-aws.test.mjs`, `scripts/test/lab-lint.test.mjs`, `scripts/test/labs-aws-template.test.mjs`

**Interfaces:**
- Produces: every batch 4 type on `AWS_TYPES` (Tasks 11–22's fixtures rely on the regenerated `computed.json`); `export function fromInternet(cidr: string): boolean` (Task 4 reads it for lab 22's router); `export function amiProblems(id: string, blocks): string[]` in `aws-content.mjs` (Tasks 13, 17 and 20 rely on it through `commonAwsProblems`, and never edit the file); `lintDir(dir, { cloud, labId })` with `labId` defaulting to the lab folder's name (Task 22's `files` output passes `commonAwsProblems` and the workflow's lint unchanged). Consumes Task 1's `AWS_PEER_REGION_LABS`, `AWS_FILES_LABS`.

**`AWS_TYPES`** gains (before the closing `]);`):
```js
  // Batch 4 (labs 20–31).
  ...["aws_vpc_ipam", "aws_vpc_ipam_pool", "aws_vpc_ipv6_cidr_block_association"].map((t) => [t, "lab 20's Free Tier IPAM: an Amazon-provided IPv6 pool in the session's region, its /56 on the lab's own VPC (ruling P5)"]),
  ["aws_vpc_ipam_pool_cidr", "lab 20's /52 of Amazon-provided IPv6, by netmask length only; NEVER_TYPES still holds it for every other lab (IPAM_LAB, ruling P5)"],
  ["aws_vpc_ipv4_cidr_block_association", "a secondary CIDR from the lab's slot (rule address)"],
  ["aws_egress_only_internet_gateway", "IPv6 egress for the lab's own VPC"],
  ["aws_ec2_managed_prefix_list", "a lab prefix list of the slot's and the headend's ranges (ruling P6)"],
  ...["aws_ec2_transit_gateway", "aws_ec2_transit_gateway_vpc_attachment", "aws_ec2_transit_gateway_route_table", "aws_ec2_transit_gateway_route_table_association", "aws_ec2_transit_gateway_route_table_propagation", "aws_ec2_transit_gateway_route", "aws_ec2_transit_gateway_peering_attachment", "aws_ec2_transit_gateway_peering_attachment_accepter"].map((t) => [t, "labs 21, 27 and 29's transit gateways, attaching only the lab's own VPCs (rulings P3, P15)"]),
  ...["aws_vpn_gateway", "aws_vpn_gateway_route_propagation", "aws_customer_gateway", "aws_vpn_connection", "aws_eip_association"].map((t) => [t, "lab 22's site-to-site VPN to its own router (ruling P11)"]),
  ...["aws_route53_resolver_endpoint", "aws_route53_resolver_rule", "aws_route53_resolver_rule_association", "aws_route53_resolver_firewall_domain_list", "aws_route53_resolver_firewall_rule_group", "aws_route53_resolver_firewall_rule", "aws_route53_resolver_firewall_rule_group_association", "aws_route53_resolver_query_log_config", "aws_route53_resolver_query_log_config_association"].map((t) => [t, "lab 23's Resolver, DNS Firewall and query logs, on the lab's own VPC (ruling P12)"]),
  ...["aws_vpc_endpoint_service", "aws_lb_target_group_attachment", "aws_lb_listener_rule"].map((t) => [t, "labs 24, 25's endpoint services (the lab's account only) and load balancer pieces (rulings P13, P14)"]),
  ...["aws_acm_certificate"].map((t) => [t, "a certificate imported from the lab's own tls resources (labs 25, 31; rulings P14, P20)"]),
  ...["tls_private_key", "tls_self_signed_cert", "tls_cert_request", "tls_locally_signed_cert"].map((t) => [t, "certificates made in the lab's state (hashicorp/tls); the keys live only in the R2 state and lab 31's sensitive files output"]),
  ...["aws_globalaccelerator_accelerator", "aws_globalaccelerator_listener", "aws_globalaccelerator_endpoint_group"].map((t) => [t, "lab 26's accelerator to its own load balancers (ruling P9)"]),
  ["aws_cloudfront_function", "lab 26's viewer-request function, named lab-<id>-* (A4)"],
  ["aws_wafv2_web_acl", "lab 26's web ACL for CloudFront in us-east-1 (rules provider, size; ruling P9)"],
  ...["aws_networkfirewall_firewall", "aws_networkfirewall_firewall_policy", "aws_networkfirewall_rule_group", "aws_networkfirewall_logging_configuration"].map((t) => [t, "lab 27's firewall in its own inspection VPC (ruling P16)"]),
  ...["aws_ec2_traffic_mirror_target", "aws_ec2_traffic_mirror_filter", "aws_ec2_traffic_mirror_filter_rule"].map((t) => [t, "lab 28's mirror target on its own instance (ruling P17)"]),
  ["aws_glue_catalog_table", "lab 28's flow-log table in lab_<id>, over the lab's own bucket (rulings P15 batch 3, P17)"],
  ["aws_vpc_peering_connection_accepter", "lab 29's accepter of its own inter-region peering (ruling P3)"],
  ...["aws_vpclattice_service_network", "aws_vpclattice_service", "aws_vpclattice_target_group", "aws_vpclattice_target_group_attachment", "aws_vpclattice_listener", "aws_vpclattice_service_network_service_association", "aws_vpclattice_service_network_vpc_association", "aws_vpclattice_auth_policy"].map((t) => [t, "lab 30's service network of its own services and VPCs (ruling P19)"]),
  ...["aws_ec2_client_vpn_endpoint", "aws_ec2_client_vpn_network_association", "aws_ec2_client_vpn_authorization_rule"].map((t) => [t, "lab 31's Client VPN into its own VPC (ruling P20)"]),
```
(`aws_flow_log`, `aws_eip`, `aws_lb*`, `aws_vpc_endpoint`, `aws_route53_zone`, `aws_cloudfront_distribution`, `aws_athena_workgroup`, `aws_glue_catalog_database` and `random_password` are already there.)

**`NEVER_TYPES`** gains (readme-only, cost or contract; §12.2 "Not built here"):
```js
  // Batch 4: Cloud WAN and RAM (lab 21), Direct Connect (lab 22), Firewall Manager (27), Shield Advanced (26) and
  // Verified Access (31) are already above; and what a lab could reach past itself with.
  /^aws_ec2_transit_gateway_(connect|multicast|policy_table|prefix_list_reference|route_table_announcement)/, /^aws_globalaccelerator_custom_routing_/,
  /^aws_networkfirewall_(tls_inspection_configuration|resource_policy)$/, /^aws_vpclattice_(resource_policy|access_log_subscription|resource_gateway|resource_configuration)/,
  /^aws_ec2_client_vpn_route$/, /^aws_route53_resolver_(config|dnssec_config|firewall_config)$/, /^aws_vpc_ipam_(scope|resource_discovery|organization_admin_account|preview_next_cidr)/,
  /^aws_vpn_connection_route$/, /^aws_cloudfront_(realtime_log_config|monitoring_subscription|key_value_store)$/, /^aws_wafv2_web_acl_logging_configuration$/,
```
(`aws_vpc_ipam_pool_cidr` stays on the list with its `IPAM_LAB` exception; rule 4 then finds it on `AWS_TYPES` for lab 20, above.)

Beside `const globalLab = AWS_GLOBAL_LABS.includes(labId);` (so rules 1 and 9 both read it):
```js
  /** Ruling P1 / P3: the labs whose peerings cross to the session's secondary region and accept their own. */
  const peerLab = AWS_PEER_REGION_LABS.includes(labId);
```
**Rule 1 (provider)**, after the batch 3 region clauses:
```js
    // Ruling P3 / P15: a peering crosses to the secondary region only in AWS_PEER_REGION_LABS, and an accepter is
    // the secondary provider's, of the lab's own peering by reference.
    for (const [t, attr] of [["aws_vpc_peering_connection", "peer_region"], ["aws_ec2_transit_gateway_peering_attachment", "peer_region"]]) {
      if (isManaged && type === t && (r.configured?.has(attr) || nonEmpty(v[attr]))) {
        if (!peerLab) refuse("provider", `${attr}: a peering crosses regions only in ${AWS_PEER_REGION_LABS.join(", ")}`);
        else if (plan && !(secondaryOk && v[attr] === variables.secondary_region)) refuse("provider", `${attr} must be the session's secondary region`);
      }
    }
    if (isManaged && ["aws_vpc_peering_connection_accepter", "aws_ec2_transit_gateway_peering_attachment_accepter"].includes(type)) {
      const key = configKeys?.[stripIndex(r.address)] ?? ""; // as rule provider finds a resource's provider block
      if (!peerLab) refuse("provider", `${type}: only ${AWS_PEER_REGION_LABS.join(", ")} accept their own peering (ruling P3)`);
      else if (mode === "plan" && key !== "aws.secondary") refuse("provider", `${type}: through the secondary provider only (ruling P3)`);
    }
```
and `DEFERRED` becomes `{}` (the accepter is judged here, by rule 9 below and by Task 4's `batch4Problems`).

**Rule 9 (gateway)**: its two peering clauses hold only outside `AWS_PEER_REGION_LABS` (inside, rule 1 judges the region and the provider, and Task 4 the accepter's own peering by reference):
```js
      // Ruling P3: only AWS_PEER_REGION_LABS accept a peering, their own (rule 1: through aws.secondary).
      if (type === "aws_vpc_peering_connection_accepter" && !peerLab) refuse("gateway", "a lab never accepts a peering: the pipeline peers the lab to the VPN server (ruling P3: only AWS_PEER_REGION_LABS accept their own)");
      if (type === "aws_vpc_peering_connection") {
        …(vpc_id and peer_vpc_id by reference: unchanged)…
        // Ruling P3 / P15: peer_region is rule 1's in AWS_PEER_REGION_LABS; another account never.
        for (const attr of ["peer_owner_id", "peer_region"]) if (r.configured?.has(attr) && !(attr === "peer_region" && peerLab)) refuse("gateway", `a lab's peering stays in this account and region: no ${attr}`);
      }
```

**Rule 11 (public)**: `fromInternet` (P6) becomes, and is exported:
```js
/** Ruling P6: a CIDR from the internet: IPv4 beyond the private ranges, or any global IPv6 range (outside fc00::/7 and fe80::/10). */
export const fromInternet = (c) => {
  if (typeof c !== "string") return false;
  if (!c.includes(":")) return Boolean(cidr4(c)) && !PRIVATE.some((p) => inside(c, p));
  const head = c.split("/")[0].toLowerCase().split(":")[0].padStart(4, "0");
  const n = parseInt(head, 16);
  return !((n & 0xfe00) === 0xfc00 || (n & 0xffc0) === 0xfe80);
};
```
**Rule 11 (public), resource policies (P7):** `resourcePolicyProblem(doc, account)` gains, inside its loop over `Allow` statements, after the principal checks:
```js
    // Ruling P7: a service principal acts for whoever calls it, so its Allow names the lab's account or resource.
    const services = list(s.Principal?.Service);
    if (services.length) {
      const cond = Object.values(s.Condition ?? {}).flatMap((o) => Object.entries(o ?? {}));
      const named = cond.some(([k, v]) => (/^aws:sourceaccount$/i.test(k) && list(v).length > 0 && list(v).every((x) => x === account)) || (/^aws:sourcearn$/i.test(k) && list(v).length > 0 && list(v).every((x) => typeof x === "string" && x.split(":")[4] === account)));
      if (!named) return `an Allow to ${services.join(", ")} names neither aws:SourceAccount (${account ? "this account" : "the plan's account"}) nor an aws:SourceArn in it (ruling P7)`;
    }
```
`RESOURCE_POLICIES` gains `["aws_vpclattice_auth_policy", "policy"]` (P19: read for who it lets in).

**`infra/ci/lab-lint.mjs`**: beside `awsDataProblems` (the AWS per-file checks; `AWS_TEXT_RULES` are regexes only):
```js
/** Ruling P2: the files output (A13) only in AWS_FILES_LABS, and sensitive, so Terraform never prints it. */
function awsFilesOutputProblems(file, code, labId) {
  const out = [];
  for (const m of code.matchAll(/\boutput\s+"files"\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(code, open);
    const body = close < 0 ? "" : code.slice(open + 1, close);
    const line = lineOf(code, m.index);
    if (!AWS_FILES_LABS.includes(labId)) out.push({ file, line, rule: "outputs", message: `output "files": only ${AWS_FILES_LABS.join(", ")} hand files to the dashboard (ruling P2)` });
    else if (!/^\s*sensitive\s*=\s*true\s*$/m.test(body)) out.push({ file, line, rule: "outputs", message: 'output "files" must say sensitive = true (ruling P2)' });
  }
  return out;
}
```
`lintTfText(files, { cloud = "azure", labId = null } = {})` calls it beside the other two (`...awsFilesOutputProblems(file, code, labId)`); `lintDir(dir, { cloud = "azure", labId = basename(dirname(resolve(dir))) } = {})` passes it on (a lab's folder is `labs/<id>/terraform`, so the workflow's `lab-lint.mjs --cloud aws labs/$LAB_ID/terraform`, `labs-check` and `commonAwsProblems` need no new argument); `basename`, `dirname` and `resolve` join the `node:path` import. A `files` output with no lab id is refused (fails closed). (`closeOf` and `lineOf` are the file's existing helpers.)

**`scripts/test/fixtures/labs/aws-content.mjs`** (the one engine change for batch 4's three AMI sources; lab tasks 13, 17 and 20 never edit this file): import `PUBLIC_INSTANCE_LABS` from `../../../../infra/ci/lab-scope-aws.mjs`, and beside `hasAttr`:
```js
/** The template's AL2023 arm64 parameter and lab 22's Ubuntu 24.04 arm64 one (ruling P11), as regex sources. */
const AL2023_PARAM = String.raw`"/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"`;
const UBUNTU_PARAM = String.raw`"/aws/service/canonical/ubuntu/server/24\.04/stable/current/arm64/hvm/ebs-gp3/ami-id"`;
/**
 * Batch 4 (rulings P9, P11, P18): what an instance's ami may read in lab `id`: the template's al2023_arm64; in Ireland
 * its twin al2023_ireland, the instance and the parameter both under provider = aws.secondary (labs 26, 29); and in
 * PUBLIC_INSTANCE_LABS (lab 22's router) ubuntu_arm64, Canonical's public parameter. [] when every instance keeps it.
 */
export function amiProblems(id, blocks) {
  const out = [];
  const secondary = (body) => hasAttr(body, "provider", String.raw`aws\.secondary`);
  const from = (body, name) => hasAttr(body, "ami", String.raw`data\.aws_ssm_parameter\.${name}\.insecure_value`);
  for (const r of blocks.filter((b) => b.kind === "resource" && b.labels[0] === "aws_instance")) {
    const ok = from(r.body, "al2023_arm64") || (from(r.body, "al2023_ireland") && secondary(r.body)) || (from(r.body, "ubuntu_arm64") && PUBLIC_INSTANCE_LABS.includes(id));
    if (!ok) out.push(`aws_instance.${r.labels[1]}: ami is not data.aws_ssm_parameter.al2023_arm64.insecure_value`);
  }
  for (const d of blocks.filter((b) => b.kind === "data" && b.labels[0] === "aws_ssm_parameter")) {
    if (d.labels[1] === "al2023_ireland" && !(secondary(d.body) && hasAttr(d.body, "name", AL2023_PARAM))) out.push('data "aws_ssm_parameter" "al2023_ireland" must be the AL2023 arm64 parameter under provider = aws.secondary');
    if (d.labels[1] === "ubuntu_arm64" && !(PUBLIC_INSTANCE_LABS.includes(id) && hasAttr(d.body, "name", UBUNTU_PARAM))) out.push(`data "aws_ssm_parameter" "ubuntu_arm64": Canonical's 24.04 arm64 parameter, only in ${PUBLIC_INSTANCE_LABS.join(", ")} (ruling P11)`);
  }
  return out;
}
```
In `commonAwsProblems`, `out.push(...amiProblems(id, l.lab.blocks));` before the `aws_instance` loop, whose `ami` line goes. The header's rule list gains "an instance's AMI is the AL2023 parameter, its Ireland twin under the secondary provider, or (lab 22 only) Canonical's Ubuntu parameter".

**`extract-computed.mjs`**: `TYPES` gains every batch 4 AWS type in the `AWS_TYPES` block above that is not already listed, and `"tls_private_key", "tls_self_signed_cert", "tls_cert_request", "tls_locally_signed_cert"` (their computed attributes: PEMs, ids). Its header gains "the hashicorp/tls schema too (batch 4)": the scratch folder pins `hashicorp/tls` at the template's version.

- [ ] **Step 1: Write the failing tests** in `scripts/test/lab-scope-aws.test.mjs` (batch 3's `T`, `U`, `rulesFor`, `ctxAws`, `ref`, `ACCOUNT` helpers):

```js
const c20 = ctxAws("ans-20-vpc-design", "20");
const c22 = ctxAws("ans-22-s2s-vpn", "22");
const c29b = ctxAws("ans-29-multi-region", "29");
const c29 = { ...c29b, variables: { ...c29b.variables, secondary_region: "eu-west-1" } };
const c24 = ctxAws("ans-24-privatelink", "24");

test("every batch 4 type is allowed with a reason; Direct Connect, Cloud WAN, RAM, Firewall Manager, Shield, Verified Access and TGW Connect stay never", () => {
  for (const t of ["aws_ec2_transit_gateway", "aws_vpn_connection", "aws_route53_resolver_rule", "aws_vpc_endpoint_service", "aws_globalaccelerator_accelerator", "aws_networkfirewall_firewall", "aws_vpclattice_service", "aws_ec2_client_vpn_endpoint", "aws_vpc_ipam", "tls_locally_signed_cert", "aws_glue_catalog_table"]) assert.ok(scope.AWS_TYPES.get(t), t);
  const never = (t) => scope.NEVER_TYPES.some((re) => re.test(t));
  for (const t of ["aws_dx_connection", "aws_networkmanager_core_network", "aws_ram_resource_share", "aws_fms_policy", "aws_shield_protection", "aws_verifiedaccess_instance", "aws_ec2_transit_gateway_connect", "aws_ec2_transit_gateway_multicast_domain", "aws_globalaccelerator_custom_routing_accelerator", "aws_networkfirewall_tls_inspection_configuration", "aws_vpclattice_resource_policy", "aws_ec2_client_vpn_route", "aws_vpc_ipam_scope"]) assert.ok(never(t), t);
  assert.ok(!never("aws_ec2_transit_gateway_route_table"));
});

test("Review Focus 1 / P3: an accepter of someone else's peering, outside lab 29 or through the default provider is refused; peer_region only to the secondary", () => {
  const pcx = (over = {}) => T(c29, "aws_vpc_peering_connection.li", { peer_region: "eu-west-1", auto_accept: false, ...over }, { unknown: ["vpc_id", "peer_vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id"), peer_vpc_id: ref("aws_vpc.ireland", "id") } });
  const acc = (key = "aws.secondary", cx = c29) => T(cx, "aws_vpc_peering_connection_accepter.li", { auto_accept: true }, { providerKey: key, unknown: ["vpc_peering_connection_id"], refs: { vpc_peering_connection_id: ref("aws_vpc_peering_connection.li", "id") } });
  assert.deepEqual(rulesFor(c29, [pcx(), acc()]), []);
  assert.deepEqual(rulesFor(c29, [pcx({ peer_region: "us-east-2" })]), ["provider: aws_vpc_peering_connection.li"]);
  assert.deepEqual(rulesFor(c29, [pcx(), acc("aws")]), ["provider: aws_vpc_peering_connection_accepter.li"]);
  const c21 = ctxAws("ans-21-transit-gateway", "21");
  assert.deepEqual([...new Set(rulesFor(c21, [T(c21, "aws_vpc_peering_connection.x", { peer_region: "eu-west-1" }, { unknown: ["vpc_id", "peer_vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id"), peer_vpc_id: ref("aws_vpc.lab", "id") } })]))].sort(), ["gateway: aws_vpc_peering_connection.x", "provider: aws_vpc_peering_connection.x"], "rule 9 still refuses peer_region outside lab 29");
  const pcx21 = T(c21, "aws_vpc_peering_connection.li", { auto_accept: false }, { unknown: ["vpc_id", "peer_vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id"), peer_vpc_id: ref("aws_vpc.lab", "id") } });
  assert.deepEqual([...new Set(rulesFor(c21, [pcx21, acc("aws.secondary", c21)]))].sort(), ["gateway: aws_vpc_peering_connection_accepter.li", "provider: aws_vpc_peering_connection_accepter.li"], "rule 9 still refuses an accepter outside lab 29");
});

test("rulings P6 and P7: a global IPv6 range is the internet; a service-principal Allow without its source is refused", () => {
  assert.deepEqual(["::/0", "2000::/3", "2a05:d018::/36", "fd00::/8", "fe80::/10", "10.64.0.0/18", "0.0.0.0/0"].map(scope.fromInternet), [true, true, true, false, false, false, true]);
  const ssh = (cidr_ipv6) => U("aws_vpc_security_group_ingress_rule.ssh6", { ip_protocol: "tcp", from_port: 22, to_port: 22, cidr_ipv6 }, { unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id") } });
  assert.deepEqual(rulesFor(c20, [ssh("2000::/3")]), ["public: aws_vpc_security_group_ingress_rule.ssh6"]);
  assert.deepEqual(rulesFor(c20, [ssh("fd00::/8")]), []);
  const bucketPolicy = (Condition) => U("aws_s3_bucket_policy.logs", { bucket: "cloudlabs-a20k3x9q-logs", policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "delivery.logs.amazonaws.com" }, Action: "s3:PutObject", Resource: "arn:aws:s3:::cloudlabs-a20k3x9q-logs/*", ...(Condition ? { Condition } : {}) }] }) });
  assert.deepEqual(rulesFor(c20, [bucketPolicy(null)]), ["public: aws_s3_bucket_policy.logs"]);
  assert.deepEqual(rulesFor(c20, [bucketPolicy({ StringEquals: { "aws:SourceAccount": "999999999999" } })]), ["public: aws_s3_bucket_policy.logs"]);
  assert.deepEqual(rulesFor(c20, [bucketPolicy({ StringEquals: { "aws:SourceAccount": ACCOUNT } })]), []);
  assert.deepEqual(rulesFor(c20, [bucketPolicy({ ArnLike: { "AWS:SourceArn": `arn:aws:logs:eu-west-2:${ACCOUNT}:*` } })]), []);
});

test("every existing AWS lab's fixture still passes rule public under ruling P7", () => {
  for (const id of ["soa-01-cloudwatch", "soa-08-vpc-fix", "soa-09-route53-cloudfront", "saa-13-decoupling", "saa-15-data-security"]) assert.deepEqual(labFixtureRules(id).filter((x) => x.startsWith("public")), [], id);
});
```
(`labFixtureRules(id)` runs `scope.checkPlanAws` on `scripts/test/fixtures/labs/plans/labs/<id>.mjs`'s plan, as `lab-plans.test.mjs` does; add it beside `rulesFor` if absent.)

In `scripts/test/lab-lint.test.mjs`:
```js
test("ruling P2 (--cloud aws): a files output only in lab 31, and only sensitive", () => {
  const out = (sensitive) => ['output "files" {', `  value     = { "a.txt" = "x" }`, ...(sensitive ? ["  sensitive = true"] : []), "}", ""].join("\n");
  const lint = (labId, s) => lintTfText({ "outputs.tf": out(s) }, { cloud: "aws", labId }).filter((p) => p.rule === "outputs").map((p) => p.line);
  assert.deepEqual(lint("ans-31-client-vpn", true), []);
  assert.deepEqual(lint("ans-31-client-vpn", false), [1]);
  assert.deepEqual(lint("ans-30-vpc-lattice", true), [1]);
  assert.deepEqual(lintTfText({ "outputs.tf": out(true) }, { cloud: "aws" }).filter((p) => p.rule === "outputs").map((p) => p.line), [1], "no lab id: refused");
});
```

In `scripts/test/labs-aws-template.test.mjs` (import `amiProblems` beside `commonAwsProblems`):
```js
test("batch 4 (rulings P9, P11): amiProblems takes al2023_arm64 anywhere, al2023_ireland only under the secondary provider, ubuntu_arm64 only in lab 22", () => {
  const vm = (name, ami, secondary = false) => ({ kind: "resource", labels: ["aws_instance", name], body: `${secondary ? "  provider = aws.secondary\n" : ""}  ami      = data.aws_ssm_parameter.${ami}.insecure_value\n` });
  const param = (name, path, secondary = false) => ({ kind: "data", labels: ["aws_ssm_parameter", name], body: `${secondary ? "  provider = aws.secondary\n" : ""}  name     = "${path}"\n` });
  const AL = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64";
  const UB = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id";
  assert.deepEqual(amiProblems("ans-26-edge", [vm("london", "al2023_arm64"), vm("ireland", "al2023_ireland", true), param("al2023_ireland", AL, true)]), []);
  assert.deepEqual(amiProblems("ans-26-edge", [vm("london", "al2023_ireland")]), ["aws_instance.london: ami is not data.aws_ssm_parameter.al2023_arm64.insecure_value"]);
  assert.deepEqual(amiProblems("ans-29-multi-region", [param("al2023_ireland", AL)]), ['data "aws_ssm_parameter" "al2023_ireland" must be the AL2023 arm64 parameter under provider = aws.secondary']);
  assert.deepEqual(amiProblems("ans-22-s2s-vpn", [vm("router", "ubuntu_arm64"), param("ubuntu_arm64", UB)]), []);
  assert.equal(amiProblems("ans-21-transit-gateway", [vm("router", "ubuntu_arm64"), param("ubuntu_arm64", UB)]).length, 2, "Ubuntu only in PUBLIC_INSTANCE_LABS");
});
```
(Every batch 1–3 lab's `commonAwsProblems(id)` test stays `[]` unchanged: they all read `al2023_arm64`.)

- [ ] **Step 2: Run them to make sure they fail**
Run: `node --test scripts/test/lab-scope-aws.test.mjs scripts/test/lab-lint.test.mjs scripts/test/labs-aws-template.test.mjs`
Expected: FAIL (types missing from `AWS_TYPES` and `computed.json`, so `realisticPlan` throws; no `fromInternet` export; rule 9 refuses lab 29's accepter; the P7 clause, the `outputs` check and `amiProblems` do not exist).

- [ ] **Step 3: Regenerate the schema facts** with batch 4's types added to `TYPES` (a scratch folder, the pinned aws, tls and time versions, `terraform providers schema -json`, no cloud calls), then `node scripts/test/fixtures/labs/plans/extract-computed.mjs <schema.json>`. If terraform cannot download providers here, say so and leave `computed.json`/`schema-facts.json` for the controller (Task 23 Step 1).

- [ ] **Step 4: Write the lists, rules, the lint check and `amiProblems`** above; the header's rule table gains the batch 4 clauses (provider: peer regions, accepters; gateway: peerings outside `AWS_PEER_REGION_LABS`; type/never: batch 4's; public: IPv6 global ranges, service principals; lint `outputs`).

- [ ] **Step 5: Run the targeted tests**
Run: `node --test scripts/test/lab-scope-aws.test.mjs scripts/test/lab-lint.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-aws-template.test.mjs scripts/test/labs-aws-soa-*.test.mjs scripts/test/labs-aws-saa-*.test.mjs`
Expected: PASS, every batch 1–3 lab's fixture and content test still clean.

- [ ] **Step 6: Commit**
```bash
git add infra/ci/lab-scope-aws.mjs infra/ci/lab-lint.mjs scripts/test/fixtures/labs/aws-content.mjs scripts/test/fixtures/labs/plans/extract-computed.mjs scripts/test/fixtures/labs/plans/computed.json scripts/test/fixtures/labs/plans/schema-facts.json scripts/test/lab-scope-aws.test.mjs scripts/test/lab-lint.test.mjs scripts/test/labs-aws-template.test.mjs
git commit -m "feat(aws labs): batch 4's types and never list; peerings cross regions only in lab 29; global IPv6 is the internet; service-principal Allows name their source; files output only in lab 31; the Ireland and Ubuntu AMI parameters in the content checks

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---

### Task 4: Scope II: batch 4's references, sizes and lingering (`batch4Problems`)

Spec: §7.3 rules 6–13, §7.4, §7.5 (ids passed as parameters: Resolver associations, Lattice VPC associations), §12.2 rows 20–31; rulings A65, A66, A68, A88, P3, P5, P6, P8, P9, P11–P20; batch 3 whole-branch minors 5 and 6.

**Files:**
- Modify: `infra/ci/lab-scope-aws.mjs` (`refsOf` reads a dotted path, so a reference inside a nested block is judged at its own path; `batch4Problems` called per managed resource after `batch3Problems`; rule 10's address clauses for secondary CIDRs, prefix-list entries, TGW routes, Client VPN CIDRs and Resolver targets; `lingeringProblems` and `sizeProblems` cases; batch 3 minor 5's size gaps and minor 6's second destinations; header)
- Test: `scripts/test/lab-scope-aws.test.mjs`

**Interfaces:**
- Consumes: Task 3's types and `fromInternet`. Produces nothing other tasks call; Tasks 11–22's fixtures must pass it.

**`refsOf`** (beside `opaque`) takes a dotted path for a value inside a nested block (`ip_address.0.subnet_id`, `config.0.vpc_identifier`, `target.0.id`, `authentication_options.0.root_certificate_chain_arn`): the value's own references first (a plan and HCL give a nested unknown the references of the expression at its own path), then the path's own entry, then its top-level attribute's, never an empty list just because `r.refs` is keyed by top-level attribute:
```js
  /** An Unknown's references: its own (plan, HCL; a nested one's from its own path), or failing that its attribute's; `attr` may be a dotted path. */
  const refsOf = (v, r, attr) => (v instanceof Unknown && v.refs?.length ? v.refs : (r.refs?.[attr] ?? r.refs?.[String(attr).split(".")[0]] ?? []));
```

**In `scopeProblemsAws`**, after `if (isManaged) batch3Problems(r, v);`: `if (isManaged) batch4Problems(r, v);`, and among the rules' details:
```js
    /** Batch 4's reference, value, size and lingering rules (rulings P3, P5, P6, P8, P9, P11–P20), one switch by type. */
    function batch4Problems(res, val) {
      const own = (x, types, attr) => {
        if (!(x instanceof Unknown)) return false;
        const refs = x.refs?.length ? x.refs : refsOf(x, res, attr);
        return (mode === "mock" && !refs.length) || ownRefs(refs, types);
      };
      const first = (x) => list(x).find(isObj) ?? {};
      const needOwn = (attr, types, rule, why) => {
        if (plan && !own(val[attr], types, attr)) refuse(rule, `${attr} must be ${why}, by reference`);
      };
      const ownAll = (attr, types, rule, why) => {
        const xs = list(val[attr]);
        if (plan && !(xs.length > 0 && xs.every((x) => own(x, types, attr)) || own(val[attr], types, attr))) refuse(rule, `every ${attr} must be ${why}, by reference`);
      };
      const inSlot = (c) => typeof c === "string" && nonEmpty(variables.address_space) && inside(c, variables.address_space);
      const ipInSlot = (ip) => typeof ip === "string" && inSlot(`${ip}/32`);
      const internal = (n) => typeof n === "string" && /\.internal\.?$/.test(n);
      const ownAccountRoot = (p) => typeof p === "string" && nonEmpty(account) && p === `arn:aws:iam::${account}:root`;
      switch (type) {
        // ── Lab 20 (ruling P5) ──
        case "aws_vpc_ipam":
          if (val.tier !== "free") refuse("size", `tier ${JSON.stringify(val.tier ?? null)}: only the Free Tier (ruling P5)`);
          if (!(list(val.operating_regions).length === 1 && first(val.operating_regions).region_name === variables.region)) refuse("provider", "operating_regions: the session's region only (ruling P5)");
          if (val.cascade !== true) refuse("lingering", "cascade must be true, so tear-down takes the pools and scopes with it (ruling P5)");
          break;
        case "aws_vpc_ipam_pool":
          if (!(val.address_family === "ipv6" && val.public_ip_source === "amazon" && val.aws_service === "ec2" && val.locale === variables.region)) refuse("address", "a lab IPAM pool is an Amazon-provided IPv6 pool for EC2 in the session's region (ruling P5)");
          needOwn("ipam_scope_id", ["aws_vpc_ipam"], "gateway", "the lab's own IPAM's scope");
          break;
        case "aws_vpc_ipam_pool_cidr":
          if (res.configured?.has("cidr") || nonEmpty(val.cidr)) refuse("never", "cidr: a lab never brings its own addresses (BYOIP); give netmask_length only (ruling P5)");
          needOwn("ipam_pool_id", ["aws_vpc_ipam_pool"], "gateway", "the lab's own pool");
          break;
        case "aws_vpc_ipv6_cidr_block_association":
          needOwn("ipv6_ipam_pool_id", ["aws_vpc_ipam_pool"], "address", "the lab's own IPv6 pool (ruling P5)");
          needOwn("vpc_id", ["aws_vpc"], "gateway", "one of the lab's own VPCs");
          break;
        case "aws_vpc_ipv4_cidr_block_association":
          if (plan && !inSlot(val.cidr_block)) refuse("address", `cidr_block ${JSON.stringify(val.cidr_block ?? null)} is outside the lab's slot`);
          if (res.configured?.has("ipv4_ipam_pool_id")) refuse("address", "an IPv4 IPAM pool needs the paid tier (ruling P5)");
          needOwn("vpc_id", ["aws_vpc"], "gateway", "one of the lab's own VPCs");
          break;
        case "aws_ec2_managed_prefix_list":
          if (val.address_family !== "IPv4") refuse("address", "a lab prefix list is IPv4 (ruling P6)");
          if (!(typeof val.max_entries === "number" && val.max_entries <= 10)) refuse("size", "max_entries at most 10 (each entry counts against every rule and route that uses the list)");
          for (const e of list(val.entry)) if (isObj(e) && plan && !(inSlot(e.cidr) || (nonEmpty(variables.gateway_cidr) && e.cidr === variables.gateway_cidr))) refuse("address", `entry ${JSON.stringify(e.cidr)}: only the slot's ranges or var.gateway_cidr (ruling P6)`);
          break;
        // ── Labs 21, 27, 29 (ruling P15) ──
        case "aws_ec2_transit_gateway":
          if (val.auto_accept_shared_attachments === "enable") refuse("gateway", "auto_accept_shared_attachments: no other account's attachment (ruling P15)");
          if (list(val.transit_gateway_cidr_blocks).length) refuse("never", "transit_gateway_cidr_blocks are for Connect, which is never (ruling P15)");
          if (val.multicast_support === "enable") refuse("never", "multicast is never (ruling P15)");
          break;
        case "aws_ec2_transit_gateway_vpc_attachment":
          needOwn("transit_gateway_id", ["aws_ec2_transit_gateway"], "gateway", "the lab's own transit gateway");
          needOwn("vpc_id", ["aws_vpc"], "gateway", "one of the lab's own VPCs");
          ownAll("subnet_ids", ["aws_subnet"], "gateway", "the lab's own subnets");
          break;
        case "aws_ec2_transit_gateway_route_table":
        case "aws_ec2_transit_gateway_route_table_association":
        case "aws_ec2_transit_gateway_route_table_propagation":
          if (type === "aws_ec2_transit_gateway_route_table") needOwn("transit_gateway_id", ["aws_ec2_transit_gateway"], "gateway", "the lab's own transit gateway");
          else {
            needOwn("transit_gateway_route_table_id", ["aws_ec2_transit_gateway_route_table", "aws_ec2_transit_gateway"], "gateway", "the lab's own route table (or its transit gateway's default one)");
            needOwn("transit_gateway_attachment_id", ["aws_ec2_transit_gateway_vpc_attachment", "aws_ec2_transit_gateway_peering_attachment", "aws_ec2_transit_gateway_peering_attachment_accepter"], "gateway", "the lab's own attachment");
          }
          break;
        case "aws_ec2_transit_gateway_route":
          if (plan && !(val.destination_cidr_block === "0.0.0.0/0" || inSlot(val.destination_cidr_block))) refuse("address", `destination ${JSON.stringify(val.destination_cidr_block ?? null)}: only the slot or 0.0.0.0/0 (ruling P15)`);
          needOwn("transit_gateway_route_table_id", ["aws_ec2_transit_gateway_route_table", "aws_ec2_transit_gateway"], "gateway", "the lab's own route table (or its transit gateway's default one)");
          if (val.blackhole !== true) needOwn("transit_gateway_attachment_id", ["aws_ec2_transit_gateway_vpc_attachment", "aws_ec2_transit_gateway_peering_attachment", "aws_ec2_transit_gateway_peering_attachment_accepter"], "gateway", "the lab's own attachment");
          break;
        case "aws_ec2_transit_gateway_peering_attachment":
          needOwn("transit_gateway_id", ["aws_ec2_transit_gateway"], "gateway", "the lab's own transit gateway");
          needOwn("peer_transit_gateway_id", ["aws_ec2_transit_gateway"], "gateway", "the lab's own transit gateway in the secondary region (ruling P15)");
          if (nonEmpty(val.peer_account_id) && val.peer_account_id !== account) refuse("gateway", "peer_account_id: this account only (ruling P15)");
          break;
        case "aws_ec2_transit_gateway_peering_attachment_accepter":
          needOwn("transit_gateway_attachment_id", ["aws_ec2_transit_gateway_peering_attachment"], "gateway", "the lab's own peering attachment (ruling P3)");
          break;
        case "aws_vpc_peering_connection_accepter":
          needOwn("vpc_peering_connection_id", ["aws_vpc_peering_connection"], "gateway", "the lab's own peering (ruling P3)");
          break;
        // ── Lab 22 (ruling P11) ──
        case "aws_vpn_gateway":
          needOwn("vpc_id", ["aws_vpc"], "gateway", "one of the lab's own VPCs");
          break;
        case "aws_vpn_gateway_route_propagation":
          needOwn("vpn_gateway_id", ["aws_vpn_gateway"], "gateway", "the lab's own gateway");
          needOwn("route_table_id", ["aws_route_table"], "gateway", "the lab's own route table");
          break;
        case "aws_customer_gateway":
          needOwn("ip_address", ["aws_eip"], "gateway", "the lab's own router's Elastic IP (ruling P11)");
          if (!(typeof val.bgp_asn === "string" || typeof val.bgp_asn === "number") || !((+val.bgp_asn >= 64512 && +val.bgp_asn <= 65534) || +val.bgp_asn >= 4200000000)) refuse("gateway", "bgp_asn: a private ASN (ruling P11)");
          if (nonEmpty(val.certificate_arn)) refuse("never", "certificate_arn needs a private CA, which is never");
          break;
        case "aws_vpn_connection":
          needOwn("customer_gateway_id", ["aws_customer_gateway"], "gateway", "the lab's own customer gateway");
          if (res.configured?.has("transit_gateway_id") || nonEmpty(val.transit_gateway_id)) refuse("gateway", "a lab VPN ends on its own virtual private gateway (ruling P11)");
          needOwn("vpn_gateway_id", ["aws_vpn_gateway"], "gateway", "the lab's own virtual private gateway");
          if (val.enable_acceleration === true) refuse("never", "enable_acceleration: accelerated VPN is readme-only (§12.2)");
          if (val.outside_ip_address_type === "PrivateIpv4") refuse("never", "PrivateIpv4 outside addresses need Direct Connect, which is never");
          for (const k of ["tunnel1_log_options", "tunnel2_log_options"]) if (list(val[k]).some((o) => isObj(o) && list(o.cloudwatch_log_options).some((x) => isObj(x) && x.log_enabled === true))) refuse("lingering", `${k}: VPN tunnel logs make a log delivery outside /cloudlabs/ (ruling P8)`);
          break;
        // ── Lab 23 (ruling P12) ──
        case "aws_route53_resolver_endpoint":
          ownAll("security_group_ids", ["aws_security_group"], "gateway", "the lab's own security groups");
          for (const [i, ip] of list(val.ip_address).entries()) if (isObj(ip) && plan && !own(ip.subnet_id, ["aws_subnet"], `ip_address.${i}.subnet_id`)) refuse("gateway", `ip_address.${i}.subnet_id must be one of the lab's own subnets, by reference`);
          if (list(val.protocols).some((p) => p !== "Do53")) refuse("size", "protocols: Do53 only");
          break;
        case "aws_route53_resolver_rule":
          if (val.rule_type !== "FORWARD") refuse("gateway", `rule_type ${JSON.stringify(val.rule_type ?? null)}: FORWARD only (ruling P12)`);
          if (!internal(val.domain_name)) refuse("gateway", `domain_name ${JSON.stringify(val.domain_name ?? null)}: a lab forwards only *.internal names (ruling P12)`);
          for (const t of list(val.target_ip)) if (isObj(t) && plan && !ipInSlot(t.ip)) refuse("address", `target_ip ${JSON.stringify(t.ip ?? null)}: an address in the lab's slot (ruling P12)`);
          needOwn("resolver_endpoint_id", ["aws_route53_resolver_endpoint"], "gateway", "the lab's own outbound endpoint");
          break;
        case "aws_route53_resolver_rule_association":
        case "aws_route53_resolver_firewall_rule_group_association":
        case "aws_route53_resolver_query_log_config_association":
          needOwn(type.endsWith("query_log_config_association") ? "resource_id" : "vpc_id", ["aws_vpc"], "gateway", "one of the lab's own VPCs (spec §7.5: a VPC passed as a parameter)");
          if (type === "aws_route53_resolver_rule_association") needOwn("resolver_rule_id", ["aws_route53_resolver_rule"], "gateway", "the lab's own rule");
          if (type === "aws_route53_resolver_firewall_rule_group_association") {
            needOwn("firewall_rule_group_id", ["aws_route53_resolver_firewall_rule_group"], "gateway", "the lab's own rule group");
            if (val.mutation_protection === "ENABLED") refuse("lingering", "mutation_protection must be DISABLED so tear-down can remove it");
          }
          if (type === "aws_route53_resolver_query_log_config_association") needOwn("resolver_query_log_config_id", ["aws_route53_resolver_query_log_config"], "gateway", "the lab's own query log config");
          break;
        case "aws_route53_resolver_firewall_rule":
          needOwn("firewall_rule_group_id", ["aws_route53_resolver_firewall_rule_group"], "gateway", "the lab's own rule group");
          needOwn("firewall_domain_list_id", ["aws_route53_resolver_firewall_domain_list"], "gateway", "the lab's own domain list");
          break;
        case "aws_route53_resolver_query_log_config":
          needOwn("destination_arn", ["aws_s3_bucket"], "lingering", "the lab's own bucket (ruling P8: vended logs to S3, never CloudWatch Logs)");
          break;
        // ── Labs 24, 25 (ruling P13) ──
        case "aws_vpc_endpoint_service": {
          const p = list(val.allowed_principals);
          if (plan && !p.every(ownAccountRoot)) refuse("public", "allowed_principals: only this account's root (ruling P13)");
          if (nonEmpty(val.private_dns_name)) refuse("gateway", "private_dns_name needs a public domain's TXT record (ruling P13)");
          if (list(val.supported_regions).some((x) => x !== variables.region)) refuse("provider", "supported_regions: the session's only");
          if (list(val.network_load_balancer_arns).length) ownAll("network_load_balancer_arns", ["aws_lb"], "gateway", "the lab's own load balancers");
          if (list(val.gateway_load_balancer_arns).length) ownAll("gateway_load_balancer_arns", ["aws_lb"], "gateway", "the lab's own load balancers");
          break;
        }
        case "aws_vpc_endpoint": {
          const n = val.service_name;
          const aws = typeof n === "string" && nonEmpty(variables.region) && n.startsWith(`com.amazonaws.${variables.region}.`) && !n.startsWith("com.amazonaws.vpce.");
          if (!(aws || (plan && own(n, ["aws_vpc_endpoint_service"], "service_name")))) refuse("gateway", `service_name ${JSON.stringify(typeof n === "string" ? n : "(computed)")}: an AWS service in the session's region or the lab's own endpoint service, by reference (ruling P13)`);
          break;
        }
        case "aws_lb_target_group_attachment":
          needOwn("target_group_arn", ["aws_lb_target_group"], "gateway", "the lab's own target group");
          needOwn("target_id", ["aws_instance"], "gateway", "the lab's own instance");
          break;
        case "aws_lb_listener_rule":
          needOwn("listener_arn", ["aws_lb_listener"], "gateway", "the lab's own listener");
          break;
        case "aws_acm_certificate":
          if (nonEmpty(val.domain_name) || res.configured?.has("domain_name")) refuse("gateway", "domain_name: a lab certificate is imported from its own tls resources, never requested (ruling P14)");
          if (nonEmpty(val.certificate_authority_arn)) refuse("never", "certificate_authority_arn: a private CA is never");
          needOwn("private_key", ["tls_private_key"], "gateway", "the lab's own key");
          needOwn("certificate_body", ["tls_locally_signed_cert", "tls_self_signed_cert"], "gateway", "the lab's own certificate");
          break;
        // ── Lab 26 (ruling P9) ──
        case "aws_globalaccelerator_endpoint_group":
          if (plan && !(val.endpoint_group_region === variables.region || (secondaryOk && val.endpoint_group_region === variables.secondary_region))) refuse("provider", "endpoint_group_region: a lab region (ruling P9)");
          for (const [i, e] of list(val.endpoint_configuration).entries()) if (isObj(e)) {
            if (plan && !own(e.endpoint_id, ["aws_lb"], `endpoint_configuration.${i}.endpoint_id`)) refuse("gateway", `endpoint_configuration.${i}.endpoint_id must be the lab's own load balancer, by reference (ruling P9)`);
            if (e.client_ip_preservation_enabled !== false) refuse("gateway", `endpoint_configuration.${i}.client_ip_preservation_enabled must be false: preservation makes untagged interfaces and a security group in the lab VPC (ruling P9)`);
          }
          needOwn("listener_arn", ["aws_globalaccelerator_listener"], "gateway", "the lab's own listener");
          break;
        case "aws_globalaccelerator_accelerator":
          if (list(val.ip_addresses).length || res.configured?.has("ip_addresses")) refuse("never", "ip_addresses: BYOIP is never");
          if (list(val.attributes).some((a) => isObj(a) && a.flow_logs_enabled === true)) refuse("lingering", "flow logs: off (ruling P8)");
          break;
        case "aws_globalaccelerator_listener":
          needOwn("accelerator_arn", ["aws_globalaccelerator_accelerator"], "gateway", "the lab's own accelerator");
          break;
        case "aws_wafv2_web_acl": {
          if (val.scope !== "CLOUDFRONT") refuse("gateway", "scope CLOUDFRONT only (ruling P9)");
          const PAID = /^AWSManagedRules(BotControl|ATP|ACFP|AntiDDoS)RuleSet$/;
          let rules = 0;
          for (const r of list(val.rule)) if (isObj(r)) {
            rules++;
            walk(r.statement, ["statement"], (kind, path, s) => {
              const key = path[path.length - 1];
              if (kind === "string" && key === "vendor_name" && s !== "AWS") refuse("size", `rule ${r.name}: managed rule groups from AWS only (ruling P9)`);
              if (kind === "string" && key === "name" && path.includes("managed_rule_group_statement") && PAID.test(s)) refuse("size", `rule ${r.name}: ${s} is billed per request and per month (ruling P9)`);
            });
          }
          if (rules > 5) refuse("size", "at most 5 rules");
          break;
        }
        case "aws_cloudfront_distribution":
          for (const fa of list(first(val.default_cache_behavior).function_association).concat(list(val.ordered_cache_behavior).flatMap((b) => list(isObj(b) ? b.function_association : [])))) if (isObj(fa) && plan && !own(fa.function_arn, ["aws_cloudfront_function"], "default_cache_behavior")) refuse("gateway", "function_association.function_arn must be the lab's own function, by reference (ruling P9)");
          if (list(first(val.default_cache_behavior).lambda_function_association).length || list(val.ordered_cache_behavior).some((b) => isObj(b) && list(b.lambda_function_association).length)) refuse("never", "Lambda@Edge runs in every edge region (ruling P9)");
          if (nonEmpty(val.web_acl_id) || val.web_acl_id instanceof Unknown) needOwn("web_acl_id", ["aws_wafv2_web_acl"], "gateway", "the lab's own web ACL");
          if (list(val.logging_config).some(isObj)) refuse("lingering", "logging_config writes to a bucket with ACLs; a lab distribution keeps no logs (ruling P8)");
          break;
        // ── Lab 27 (ruling P16) ──
        case "aws_networkfirewall_firewall":
          if (list(val.subnet_mapping).length !== 1) refuse("size", "one subnet mapping (spec §7.3, ruling P16)");
          for (const k of ["delete_protection", "subnet_change_protection", "firewall_policy_change_protection"]) if (val[k] === true) refuse("lingering", `${k} must be false (ruling P16)`);
          needOwn("vpc_id", ["aws_vpc"], "gateway", "one of the lab's own VPCs");
          needOwn("firewall_policy_arn", ["aws_networkfirewall_firewall_policy"], "gateway", "the lab's own policy");
          break;
        case "aws_networkfirewall_rule_group":
          if (!(typeof val.capacity === "number" && val.capacity <= 100)) refuse("size", "capacity at most 100 (ruling P16)");
          break;
        case "aws_networkfirewall_firewall_policy":
          if (nonEmpty(first(val.firewall_policy).tls_inspection_configuration_arn)) refuse("never", "TLS inspection is never (ruling P16)");
          break;
        case "aws_networkfirewall_logging_configuration":
          for (const d of list(first(val.logging_configuration).log_destination_config)) if (isObj(d) && d.log_destination_type !== "S3") refuse("lingering", `log_destination_type ${JSON.stringify(d.log_destination_type ?? null)}: the lab's bucket only (ruling P8)`);
          break;
        // ── Lab 28 (ruling P17) ──
        case "aws_ec2_traffic_mirror_target":
          if (res.configured?.has("network_load_balancer_arn") || res.configured?.has("gateway_load_balancer_endpoint_id")) refuse("gateway", "a mirror target is the lab's own instance's interface (ruling P17)");
          needOwn("network_interface_id", ["aws_instance"], "gateway", "the lab's own instance's primary interface");
          break;
        case "aws_ec2_traffic_mirror_filter_rule":
          for (const k of ["source_cidr_block", "destination_cidr_block"]) if (plan && !(val[k] === "0.0.0.0/0" || inSlot(val[k]))) refuse("address", `${k}: the slot or 0.0.0.0/0`);
          needOwn("traffic_mirror_filter_id", ["aws_ec2_traffic_mirror_filter"], "gateway", "the lab's own filter");
          break;
        case "aws_glue_catalog_table": {
          const loc = first(val.storage_descriptor).location;
          if (plan && !(typeof loc === "string" && nonEmpty(variables.name_prefix) && loc.startsWith(`s3://cloudlabs-${variables.name_prefix}-`))) refuse("gateway", "storage_descriptor.location must be in the lab's own bucket (ruling P17)");
          if (!startsKnown(val.database_name, glueName) && !(plan && own(val.database_name, ["aws_glue_catalog_database"], "database_name"))) refuse("gateway", `database_name must be the lab's own database (${glueName})`);
          break;
        }
        case "aws_flow_log":
          if (val.log_destination_type === "s3") needOwn("log_destination", ["aws_s3_bucket"], "lingering", "the lab's own bucket (ruling P8)");
          if (val.log_destination_type === "kinesis-data-firehose") refuse("lingering", "Firehose flow logs: a lab's own group or bucket only (ruling P8)");
          break;
        // ── Lab 30 (ruling P19) ──
        case "aws_vpclattice_service_network_vpc_association":
          needOwn("vpc_identifier", ["aws_vpc"], "gateway", "one of the lab's own VPCs (spec §7.5)");
          ownAll("security_group_ids", ["aws_security_group"], "gateway", "the lab's own security groups");
          needOwn("service_network_identifier", ["aws_vpclattice_service_network"], "gateway", "the lab's own service network");
          break;
        case "aws_vpclattice_service_network_service_association":
          needOwn("service_identifier", ["aws_vpclattice_service"], "gateway", "the lab's own service");
          needOwn("service_network_identifier", ["aws_vpclattice_service_network"], "gateway", "the lab's own service network");
          break;
        case "aws_vpclattice_target_group":
          if (val.type !== "INSTANCE") refuse("gateway", "type INSTANCE: the lab's own instances (ruling P19)");
          if (plan && !own(first(val.config).vpc_identifier, ["aws_vpc"], "config.0.vpc_identifier")) refuse("gateway", "config.vpc_identifier must be one of the lab's own VPCs, by reference");
          break;
        case "aws_vpclattice_target_group_attachment":
          needOwn("target_group_identifier", ["aws_vpclattice_target_group"], "gateway", "the lab's own target group");
          for (const [i, t] of list(val.target).entries()) if (isObj(t) && plan && !own(t.id, ["aws_instance"], `target.${i}.id`)) refuse("gateway", `target.${i}.id must be the lab's own instance, by reference`);
          break;
        case "aws_vpclattice_auth_policy":
          needOwn("resource_identifier", ["aws_vpclattice_service", "aws_vpclattice_service_network"], "gateway", "the lab's own service or network");
          break;
        // ── Lab 31 (ruling P20) ──
        case "aws_ec2_client_vpn_endpoint": {
          if (plan && !inSlot(val.client_cidr_block)) refuse("address", "client_cidr_block must be inside the lab's slot (ruling P20)");
          const kinds = list(val.authentication_options).filter(isObj).map((a) => a.type);
          if (!(kinds.length > 0 && kinds.every((k) => k === "certificate-authentication"))) refuse("never", "certificate authentication only; directory and federated authentication are never (ruling P20)");
          if (val.split_tunnel !== true) refuse("gateway", "split_tunnel must be true: a lab VPN never takes Steven's whole internet (ruling P20)");
          if (first(val.connection_log_options).enabled === true) refuse("lingering", "connection logging off (ruling P8)");
          if (val.self_service_portal === "enabled") refuse("public", "self_service_portal must be disabled");
          needOwn("server_certificate_arn", ["aws_acm_certificate"], "gateway", "the lab's own imported certificate");
          for (const [i, a] of list(val.authentication_options).entries()) if (isObj(a) && plan && !own(a.root_certificate_chain_arn, ["aws_acm_certificate"], `authentication_options.${i}.root_certificate_chain_arn`)) refuse("gateway", `authentication_options.${i}.root_certificate_chain_arn must be the lab's own imported certificate, by reference (ruling P20)`);
          needOwn("vpc_id", ["aws_vpc"], "gateway", "one of the lab's own VPCs");
          if (list(val.security_group_ids).length || val.security_group_ids instanceof Unknown) ownAll("security_group_ids", ["aws_security_group"], "gateway", "the lab's own security groups");
          break;
        }
        case "aws_ec2_client_vpn_network_association":
          needOwn("client_vpn_endpoint_id", ["aws_ec2_client_vpn_endpoint"], "gateway", "the lab's own endpoint");
          needOwn("subnet_id", ["aws_subnet"], "gateway", "one of the lab's own subnets");
          if (++clientVpnAssociations > 1) refuse("size", "one target network association (each bills by the hour; ruling P20)");
          break;
        case "aws_ec2_client_vpn_authorization_rule":
          if (plan && !inSlot(val.target_network_cidr)) refuse("address", "target_network_cidr must be inside the lab's slot (ruling P20)");
          break;
        default:
      }
    }
```
with `let clientVpnAssociations = 0;` and `let tgwAttachments = new Map();` beside `natGateways`, and in `sizeProblems`:
```js
      // Ruling P15: at most 4 VPC attachments per transit gateway (counted by the transit gateway's reference).
      if (type === "aws_ec2_transit_gateway_vpc_attachment") {
        const tgw = refsOf(val.transit_gateway_id, res, "transit_gateway_id")[0] ?? "?";
        tgwAttachments.set(tgw, (tgwAttachments.get(tgw) ?? 0) + 1);
        if (tgwAttachments.get(tgw) > 4) no("size", "at most 4 VPC attachments on one transit gateway (ruling P15)");
      }
      // Batch 3 whole-branch minor 5: a node group must name its sizes; ElastiCache replicas and global groups are capped.
      if (type === "aws_eks_node_group" && !list(val.instance_types).length) no("size", "instance_types must be set (else EKS picks t3.medium)");
      if (type === "aws_elasticache_replication_group" && typeof val.replicas_per_node_group === "number" && val.replicas_per_node_group > 1) no("size", "replicas_per_node_group at most 1");
      if (type === "aws_elasticache_replication_group" && nonEmpty(val.global_replication_group_id)) no("gateway", "global_replication_group_id reaches other regions");
```
and in `batch3Problems`' event-target, queue and crawler cases (batch 3 whole-branch minor 6): `dead_letter_config.arn` own `aws_sqs_queue`; `aws_sqs_queue.redrive_policy`'s `deadLetterTargetArn` the lab's own queue (known at plan, starting `arn:aws:sqs:<region>:<account>:lab-<id>-`); a crawler's `event_queue_arn`/`dlq_event_queue_arn` refused (no lab sets them); a Cognito pool's `lambda_config` refused unless every ARN is the lab's own function by reference; a state machine's `logging_configuration.log_destination` the lab's own log group by reference.

Rule 10 (address) gains, beside the route checks: a route's `destination_prefix_list_id` is the lab's own `aws_ec2_managed_prefix_list` by reference or an AWS-managed list from `aws_ec2_managed_prefix_list` data (`com.amazonaws.`); a route whose target is `transit_gateway_id`, `vpn_gateway_id`, `egress_only_gateway_id` or `vpc_endpoint_id` names the lab's own gateway, endpoint or transit gateway by reference (or, for `vpc_endpoint_id`, a value built from the lab's own Network Firewall's `firewall_status`); an `aws_route` with `destination_ipv6_cidr_block` takes `::/0` only (unchanged).

Rule 11 (public) gains, for `PUBLIC_INSTANCE_LABS` (lab 22, P11): every security group ingress rule (`aws_vpc_security_group_ingress_rule`, `aws_security_group_rule`, inline `ingress`) whose source is from the internet (`fromInternet`, a literal) is refused, and one whose CIDR is not known at plan must be UDP 500 or 4500 built from the lab's own `aws_vpn_connection`'s `tunnel1_address` or `tunnel2_address` by reference; the router's other rules name lab security groups.

`lingeringProblems` gains `aws_route53_resolver_firewall_rule_group_association` (mutation protection, above), and `aws_lb` with `load_balancer_type = "gateway"` under the existing `enable_deletion_protection` check (unchanged code: the type is already an `aws_lb`).

- [ ] **Step 1: Write the failing tests** in `scripts/test/lab-scope-aws.test.mjs`:

```js
const c21 = ctxAws("ans-21-transit-gateway", "21");
const c23 = ctxAws("ans-23-hybrid-dns", "23");
const c26b = ctxAws("ans-26-edge", "26");
const c26 = { ...c26b, variables: { ...c26b.variables, secondary_region: "eu-west-1" } };
const c27 = ctxAws("ans-27-network-firewall", "27");
const c28 = ctxAws("ans-28-flow-logs-fix", "28");
const c30 = ctxAws("ans-30-vpc-lattice", "30");
const c31 = ctxAws("ans-31-client-vpn", "31");
const byRef = (attr, target) => ({ unknown: [attr], refs: { [attr]: ref(target, attr.endsWith("arn") ? "arn" : "id") } });
const refs = (pairs) => ({ unknown: Object.keys(pairs), refs: Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, ref(v, k.endsWith("arn") || k.endsWith("_arns") ? "arn" : "id")])) });

test("Review Focus 2: refuses an attachment, route, gateway, rule, endpoint, accelerator, auth policy, mirror target or Client VPN piece that names anything not the lab's own", () => {
  const tgw = T(c21, "aws_ec2_transit_gateway.lab", { auto_accept_shared_attachments: "disable", default_route_table_association: "disable", default_route_table_propagation: "disable" });
  assert.deepEqual(rulesFor(c21, [tgw, T(c21, "aws_ec2_transit_gateway_vpc_attachment.a", {}, refs({ transit_gateway_id: "aws_ec2_transit_gateway.lab", vpc_id: "aws_vpc.lab", subnet_ids: "aws_subnet.private" }))]), []);
  assert.deepEqual(rulesFor(c21, [tgw, T(c21, "aws_ec2_transit_gateway_vpc_attachment.a", { vpc_id: "vpc-0123456789abcdef0" }, refs({ transit_gateway_id: "aws_ec2_transit_gateway.lab", subnet_ids: "aws_subnet.private" }))]), ["gateway: aws_ec2_transit_gateway_vpc_attachment.a"]);
  assert.deepEqual(rulesFor(c21, [tgw, U("aws_ec2_transit_gateway_route.out", { destination_cidr_block: "8.8.8.0/24" }, refs({ transit_gateway_route_table_id: "aws_ec2_transit_gateway_route_table.spokes", transit_gateway_attachment_id: "aws_ec2_transit_gateway_vpc_attachment.a" }))]), ["address: aws_ec2_transit_gateway_route.out"]);
  assert.deepEqual(rulesFor(c22, [T(c22, "aws_vpn_connection.lab", { type: "ipsec.1", static_routes_only: false, enable_acceleration: true }, refs({ customer_gateway_id: "aws_customer_gateway.onprem", vpn_gateway_id: "aws_vpn_gateway.lab" }))]), ["never: aws_vpn_connection.lab"]);
  assert.deepEqual(rulesFor(c22, [T(c22, "aws_customer_gateway.x", { bgp_asn: "65001", ip_address: "203.0.113.10", type: "ipsec.1" })]), ["gateway: aws_customer_gateway.x"]);
  const rule = (over) => T(c23, "aws_route53_resolver_rule.corp", { rule_type: "FORWARD", domain_name: "corp.a23k3x9q.internal", target_ip: [{ ip: "10.64.80.10", port: 53 }], ...over }, refs({ resolver_endpoint_id: "aws_route53_resolver_endpoint.out" }));
  assert.deepEqual(rulesFor(c23, [rule({})]), []);
  assert.deepEqual(rulesFor(c23, [rule({ domain_name: "amazonaws.com" })]), ["gateway: aws_route53_resolver_rule.corp"]);
  assert.deepEqual(rulesFor(c23, [rule({ target_ip: [{ ip: "8.8.8.8", port: 53 }] })]), ["address: aws_route53_resolver_rule.corp"]);
  assert.deepEqual(rulesFor(c23, [U("aws_route53_resolver_rule_association.x", { vpc_id: "vpc-0123456789abcdef0" }, refs({ resolver_rule_id: "aws_route53_resolver_rule.corp" }))]), ["gateway: aws_route53_resolver_rule_association.x"]);
  const svc = (principals) => T(c24, "aws_vpc_endpoint_service.lab", { acceptance_required: false, allowed_principals: principals }, refs({ network_load_balancer_arns: "aws_lb.provider" }));
  assert.deepEqual(rulesFor(c24, [svc([`arn:aws:iam::${ACCOUNT}:root`])]), []);
  assert.deepEqual(rulesFor(c24, [svc(["*"])]), ["public: aws_vpc_endpoint_service.lab"]);
  assert.deepEqual(rulesFor(c24, [T(c24, "aws_vpc_endpoint.theirs", { vpc_endpoint_type: "Interface", service_name: "com.amazonaws.vpce.eu-west-2.vpce-svc-0123456789abcdef0" }, refs({ vpc_id: "aws_vpc.lab" }))], templateResources(c24)), ["gateway: aws_vpc_endpoint.theirs"]);
  const eg = (pres) => U("aws_globalaccelerator_endpoint_group.ldn", { endpoint_group_region: "eu-west-2", endpoint_configuration: [{ weight: 100, client_ip_preservation_enabled: pres }] }, { unknown: ["endpoint_configuration.0.endpoint_id", "listener_arn"], refs: { "endpoint_configuration.0.endpoint_id": ref("aws_lb.london", "arn"), listener_arn: ref("aws_globalaccelerator_listener.http", "id") } });
  assert.deepEqual(rulesFor(c26, [eg(false)]), []);
  assert.deepEqual(rulesFor(c26, [eg(true)]), ["gateway: aws_globalaccelerator_endpoint_group.ldn"]);
  assert.deepEqual(rulesFor(c30, [U("aws_vpclattice_service_network_vpc_association.x", { vpc_identifier: "vpc-0123456789abcdef0" }, refs({ service_network_identifier: "aws_vpclattice_service_network.lab", security_group_ids: "aws_security_group.lattice" }))]), ["gateway: aws_vpclattice_service_network_vpc_association.x"]);
  assert.deepEqual(rulesFor(c28, [T(c28, "aws_ec2_traffic_mirror_target.x", { network_interface_id: "eni-0123456789abcdef0" })]), ["gateway: aws_ec2_traffic_mirror_target.x"]);
  const cvpn = (over) => T(c31, "aws_ec2_client_vpn_endpoint.lab", { client_cidr_block: "10.64.124.0/22", split_tunnel: true, transport_protocol: "udp", authentication_options: [{ type: "certificate-authentication" }], connection_log_options: [{ enabled: false }], self_service_portal: "disabled", ...over }, { unknown: ["server_certificate_arn", "vpc_id", "authentication_options.0.root_certificate_chain_arn"], refs: { server_certificate_arn: ref("aws_acm_certificate.server", "arn"), vpc_id: ref("aws_vpc.lab", "id"), "authentication_options.0.root_certificate_chain_arn": ref("aws_acm_certificate.server", "arn") } });
  assert.deepEqual(rulesFor(c31, [cvpn({})]), []);
  assert.deepEqual(rulesFor(c31, [cvpn({ client_cidr_block: "172.16.0.0/22" })]), ["address: aws_ec2_client_vpn_endpoint.lab"]);
  assert.deepEqual(rulesFor(c31, [cvpn({ authentication_options: [{ type: "federated-authentication" }] })]), ["never: aws_ec2_client_vpn_endpoint.lab"]);
  assert.deepEqual(rulesFor(c31, [cvpn({ split_tunnel: false })]), ["gateway: aws_ec2_client_vpn_endpoint.lab"]);
});

test("refsOf resolves references inside nested blocks: ip_address.N.subnet_id, config.0.vpc_identifier, target.0.id, authentication_options.0.root_certificate_chain_arn", () => {
  // Each block's sibling points at the lab's own item, so only a per-path read refuses the foreign one.
  const ep = (second) => T(c23, "aws_route53_resolver_endpoint.in", { name: "lab-ans-23-hybrid-dns-in", direction: "INBOUND", protocols: ["Do53"], ip_address: [{}, {}] }, refs({ "ip_address.0.subnet_id": "aws_subnet.private", "ip_address.1.subnet_id": second, security_group_ids: "aws_security_group.resolver" }));
  assert.deepEqual(rulesFor(c23, [ep("aws_subnet.private")]), []);
  assert.deepEqual(rulesFor(c23, [ep("data.aws_subnet.other")]), ["gateway: aws_route53_resolver_endpoint.in"]);
  const tg = (vpc) => T(c30, "aws_vpclattice_target_group.a", { name: "lab-ans-30-vpc-lattice-tg-a", type: "INSTANCE", config: [{ port: 80, protocol: "HTTP" }] }, refs({ "config.0.vpc_identifier": vpc }));
  assert.deepEqual(rulesFor(c30, [tg("aws_vpc.lab")]), []);
  assert.deepEqual(rulesFor(c30, [tg("data.aws_vpc.other")]), ["gateway: aws_vpclattice_target_group.a"]);
  const att = (vm) => U("aws_vpclattice_target_group_attachment.a", { target: [{ port: 80 }] }, refs({ target_group_identifier: "aws_vpclattice_target_group.a", "target.0.id": vm }));
  assert.deepEqual(rulesFor(c30, [att("aws_instance.svc_a")]), []);
  assert.deepEqual(rulesFor(c30, [att("aws_vpc.lab")]), ["gateway: aws_vpclattice_target_group_attachment.a"]);
  const cv = (chain) => T(c31, "aws_ec2_client_vpn_endpoint.lab", { client_cidr_block: "10.64.124.0/22", split_tunnel: true, transport_protocol: "udp", authentication_options: [{ type: "certificate-authentication" }], connection_log_options: [{ enabled: false }], self_service_portal: "disabled" }, refs({ server_certificate_arn: "aws_acm_certificate.server", vpc_id: "aws_vpc.lab", security_group_ids: "aws_security_group.cvpn", "authentication_options.0.root_certificate_chain_arn": chain }));
  assert.deepEqual(rulesFor(c31, [cv("aws_acm_certificate.server")]), []);
  assert.deepEqual(rulesFor(c31, [cv("data.aws_acm_certificate.issued")]), ["gateway: aws_ec2_client_vpn_endpoint.lab"]);
});

test("rulings P8, P9 and P11: vended logs to CloudWatch, a paid WAF group, an open router and an accelerated VPN are refused", () => {
  assert.deepEqual(rulesFor(c23, [T(c23, "aws_route53_resolver_query_log_config.lab", { name: "lab-ans-23-hybrid-dns-queries", destination_arn: `arn:aws:logs:eu-west-2:${ACCOUNT}:log-group:/cloudlabs/ans-23-hybrid-dns/q` })]), ["lingering: aws_route53_resolver_query_log_config.lab"]);
  assert.deepEqual(rulesFor(c27, [U("aws_networkfirewall_logging_configuration.lab", { logging_configuration: [{ log_destination_config: [{ log_destination_type: "CloudWatchLogs", log_type: "ALERT" }] }] }, refs({ firewall_arn: "aws_networkfirewall_firewall.lab" }))]), ["lingering: aws_networkfirewall_logging_configuration.lab"]);
  const waf = (name) => T(c26, "aws_wafv2_web_acl.lab", { name: "lab-ans-26-edge-waf", region: "us-east-1", scope: "CLOUDFRONT", default_action: [{ allow: [{}] }], rule: [{ name: "m", priority: 1, statement: [{ managed_rule_group_statement: [{ vendor_name: "AWS", name }] }], override_action: [{ none: [{}] }] }] });
  assert.deepEqual(rulesFor(c26, [waf("AWSManagedRulesCommonRuleSet")]), []);
  assert.deepEqual(rulesFor(c26, [waf("AWSManagedRulesBotControlRuleSet")]), ["size: aws_wafv2_web_acl.lab"]);
  const routerSg = (rule) => U(`aws_vpc_security_group_ingress_rule.r`, rule.values, rule.more);
  assert.deepEqual(rulesFor(c22, [routerSg({ values: { ip_protocol: "udp", from_port: 500, to_port: 500 }, more: { unknown: ["cidr_ipv4", "security_group_id"], refs: { cidr_ipv4: ref("aws_vpn_connection.lab", "tunnel1_address"), security_group_id: ref("aws_security_group.router", "id") } } })]), []);
  assert.deepEqual(rulesFor(c22, [routerSg({ values: { ip_protocol: "udp", from_port: 500, to_port: 500, cidr_ipv4: "0.0.0.0/0" }, more: { unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.router", "id") } } })]), ["public: aws_vpc_security_group_ingress_rule.r"]);
});

test("rulings P5, P6 and P16: IPAM tiers and pools, prefix list entries, the firewall's mapping and protections", () => {
  assert.deepEqual(rulesFor(c20, [T(c20, "aws_vpc_ipam.lab", { tier: "advanced", operating_regions: [{ region_name: "eu-west-2" }], cascade: true })]), ["size: aws_vpc_ipam.lab"]);
  assert.deepEqual(rulesFor(c20, [U("aws_vpc_ipam_pool_cidr.v6", { cidr: "2001:db8::/52" }, refs({ ipam_pool_id: "aws_vpc_ipam_pool.v6" }))]), ["never: aws_vpc_ipam_pool_cidr.v6"]);
  assert.deepEqual(rulesFor(ctxAws("ans-21-transit-gateway", "21"), [U("aws_vpc_ipam_pool_cidr.v6", { netmask_length: 52 }, refs({ ipam_pool_id: "aws_vpc_ipam_pool.v6" }))]), ["never: aws_vpc_ipam_pool_cidr.v6"], "only lab 20");
  const pl = (cidr) => T(c20, "aws_ec2_managed_prefix_list.admin", { name: "lab-ans-20-vpc-design-admin", address_family: "IPv4", max_entries: 4, entry: [{ cidr, description: "x" }] });
  assert.deepEqual(rulesFor(c20, [pl("10.50.0.0/16")]), []);
  assert.deepEqual(rulesFor(c20, [pl("0.0.0.0/0")]), ["address: aws_ec2_managed_prefix_list.admin"]);
  const fw = (over) => T(c27, "aws_networkfirewall_firewall.lab", { name: "lab-ans-27-network-firewall", delete_protection: false, subnet_change_protection: false, firewall_policy_change_protection: false, subnet_mapping: [{}], ...over }, refs({ vpc_id: "aws_vpc.inspection", firewall_policy_arn: "aws_networkfirewall_firewall_policy.lab" }));
  assert.deepEqual(rulesFor(c27, [fw({})]), []);
  assert.deepEqual(rulesFor(c27, [fw({ subnet_mapping: [{}, {}] })]), ["size: aws_networkfirewall_firewall.lab"]);
  assert.deepEqual(rulesFor(c27, [fw({ delete_protection: true })]), ["lingering: aws_networkfirewall_firewall.lab"]);
});

test("ruling P15 and batch 3 minor 5: transit gateway attachment count, EKS node sizes, ElastiCache replicas", () => {
  const tgw = T(c21, "aws_ec2_transit_gateway.lab", { auto_accept_shared_attachments: "disable" });
  const att = (i) => T(c21, `aws_ec2_transit_gateway_vpc_attachment.a${i}`, {}, refs({ transit_gateway_id: "aws_ec2_transit_gateway.lab", vpc_id: "aws_vpc.lab", subnet_ids: "aws_subnet.private" }));
  assert.deepEqual(rulesFor(c21, [tgw, ...[1, 2, 3, 4].map(att)]), []);
  assert.deepEqual(rulesFor(c21, [tgw, ...[1, 2, 3, 4, 5].map(att)]), ["size: aws_ec2_transit_gateway_vpc_attachment.a5"]);
  const c19 = ctxAws("saa-19-eks", "19");
  assert.deepEqual(rulesFor(c19, [T(c19, "aws_eks_node_group.lab", { cluster_name: "lab-saa-19-eks", node_group_name: "lab-saa-19-eks-ng", scaling_config: [{ desired_size: 1, min_size: 1, max_size: 2 }] }, refs({ node_role_arn: "aws_iam_role.node", subnet_ids: "aws_subnet.private" }))], templateResources(c19)).filter((x) => x.startsWith("size")), ["size: aws_eks_node_group.lab"]);
});
```

- [ ] **Step 2: Run them to make sure they fail**
Run: `node --test scripts/test/lab-scope-aws.test.mjs`
Expected: FAIL (`batch4Problems` does not exist; every case above passes unrefused).

- [ ] **Step 3: Write the rules** above; the header's rule table gains, per rule, the batch 4 clauses (gateway: attachments, routes, gateways, rules, associations, endpoint services and endpoints, accelerator endpoints, Lattice pieces, mirror targets, Client VPN pieces, CloudFront functions and ACLs; address: secondary CIDRs, prefix lists, TGW routes, Resolver targets, Client VPN CIDRs; public: endpoint service principals, the lab-22 router; lingering: vended-log destinations, firewall and association protections; size: IPAM tier, attachments, firewall mapping and capacity, WAF groups, Client VPN associations; never: BYOIP, private CAs, accelerated VPN, TLS inspection, federated Client VPN).

- [ ] **Step 4: Run the targeted tests**
Run: `node --test scripts/test/lab-scope-aws.test.mjs scripts/test/lab-plans.test.mjs`
Expected: PASS, every batch 1–3 lab's fixture still clean.

- [ ] **Step 5: Commit**
```bash
git add infra/ci/lab-scope-aws.mjs scripts/test/lab-scope-aws.test.mjs
git commit -m "feat(aws labs): scope for batch 4's references, sizes and lingering: attachments, VPNs, Resolver, PrivateLink, accelerators, WAF, firewalls, mirroring, Lattice, Client VPN; batch 3 minors 5 and 6

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---

### Task 5: Clean-up I: edge, DNS and Lattice (Global Accelerator, WAF, CloudFront functions, Resolver, Lattice), Verify states

Spec: §8.2 phase 2, §8.3, §15 (slow deletes); rulings A36, A53, P9, P10, P12, P19, P23; batch 2 final review M-4.

**Files:**
- Modify: `infra/ci/lab-aws-safety-net.sh` (`split_arn` reads WAF and Lattice listener ARNs; discovery by name of CloudFront functions; `describe` and `judge` for the new types; handlers; `HANDLED`; phase 2's run order; the CloudFront disable retry; header)
- Test: `scripts/test/lab-aws-cleanup.test.mjs`, `scripts/test/aws-labs-iam.test.mjs` (the CLI-coverage test's lists)

**Interfaces:**
- Consumes: Task 2's policies (every call is a `LabServices`/`GlobalServices` read, a tagged change, or a delete of an item found by the lab's name). Produces nothing other tasks call.

**`split_arn`**, after batch 3's API Gateway branch:
```bash
  # Ruling P22: arn:aws:wafv2:us-east-1:<a>:global/webacl/<name>/<id>: the scope and kind are the type; name/id the ID.
  if [ "$service" = wafv2 ]; then
    TYPE="wafv2:$(cut -d/ -f1,2 <<<"$rest")"; ID="$(cut -d/ -f3- <<<"$rest")"
    return
  fi
  # arn:aws:vpc-lattice:<r>:<a>:service/<svc>/listener/<l>: a listener goes with its service.
  if [ "$service" = vpc-lattice ] && [[ "$rest" == service/*/listener/* ]]; then
    TYPE=vpc-lattice:listener; ID="${rest#service/}"
    return
  fi
```
**Discovery**, inside the lab-regions block beside batch 2's origin access controls (run once, the CloudFront API being global):
```bash
      # Ruling P10 (A4): CloudFront functions are the lab's by name.
      if json="$(awsq "$r" cloudfront list-functions --stage DEVELOPMENT)"; then
        while IFS= read -r n; do [ -n "$n" ] && add "$r" cloudfront:function "$n" "" "$n" 0; done < <(jq -r --arg p "$PREFIX" '.FunctionList.Items[]?.Name // empty | select(startswith($p))' <<<"$json")
      else
        list_failed "CloudFront functions"
      fi
```
(guarded to run in the first lab region only, as the OAC listing is.)

**`describe`** gains:
```bash
    globalaccelerator:accelerator) set -- globalaccelerator describe-accelerator --accelerator-arn "$x"; q='.Accelerator' ;;
    wafv2:global/webacl) set -- wafv2 get-web-acl --scope CLOUDFRONT --name "${id%%/*}" --id "${id#*/}"; q='.' ;;
    cloudfront:function) set -- cloudfront describe-function --name "$id"; q='.' ;;
    route53resolver:resolver-endpoint) set -- route53resolver get-resolver-endpoint --resolver-endpoint-id "$id"; q='.ResolverEndpoint' ;;
    route53resolver:resolver-rule) set -- route53resolver get-resolver-rule --resolver-rule-id "$id"; q='.ResolverRule' ;;
    route53resolver:resolver-query-log-config) set -- route53resolver get-resolver-query-log-config --resolver-query-log-config-id "$id"; q='.ResolverQueryLogConfig' ;;
    route53resolver:firewall-rule-group) set -- route53resolver get-firewall-rule-group --firewall-rule-group-id "$id"; q='.FirewallRuleGroup' ;;
    route53resolver:firewall-rule-group-association) set -- route53resolver get-firewall-rule-group-association --firewall-rule-group-association-id "$id"; q='.FirewallRuleGroupAssociation' ;;
    route53resolver:firewall-domain-list) set -- route53resolver get-firewall-domain-list --firewall-domain-list-id "$id"; q='.FirewallDomainList' ;;
    vpc-lattice:servicenetwork) set -- vpc-lattice get-service-network --service-network-identifier "$id"; q='.' ;;
    vpc-lattice:service) set -- vpc-lattice get-service --service-identifier "$id"; q='.' ;;
    vpc-lattice:targetgroup) set -- vpc-lattice get-target-group --target-group-identifier "$id"; q='.' ;;
    vpc-lattice:servicenetworkvpcassociation) set -- vpc-lattice get-service-network-vpc-association --service-network-vpc-association-identifier "$id"; q='.' ;;
    vpc-lattice:servicenetworkserviceassociation) set -- vpc-lattice get-service-network-service-association --service-network-service-association-identifier "$id"; q='.' ;;
```
(`awsq` signs Global Accelerator in us-west-2 and WAF CLOUDFRONT in us-east-1: their candidates are found in those regions, so `C_R` is right.) **`judge`** gains (ruling P23): `route53resolver:resolver-endpoint) g='.Status == "DELETING"' ;;` is **not** added (the safety net waits for it until not found, below); `vpc-lattice:servicenetworkvpcassociation|vpc-lattice:servicenetworkserviceassociation) g='.status == "DELETE_IN_PROGRESS"' ;;`. Everything else is there until AWS no longer has it.

**Handlers** (phase 2, after `distributions` and `del_oac`):
```bash
# Ruling P10: a function in use by a distribution cannot go, so functions follow the distributions.
del_function() {
  local i="$1" etag
  describe "$i"
  [ $? -eq 1 ] && return 1
  etag="$(jq -r '.ETag // empty' <<<"$DJ" 2>/dev/null)"
  wr "$i" "delete $(label "$i")" cloudfront delete-function --name "${C_I[$i]}" --if-match "$etag"
}
# Ruling P10: Global Accelerator, in us-west-2: disable, wait until DEPLOYED and disabled, endpoint groups, listeners,
# then the accelerator (AWS refuses each step out of this order).
del_accelerator() {
  local i="$1" a="${C_A[$1]}" r="${C_R[$1]}" json l g
  describe "$i"
  [ $? -eq 1 ] && return 1
  [ "$(jq -r '.Enabled' <<<"$DJ" 2>/dev/null)" = true ] && wr "$i" "disable $(label "$i")" globalaccelerator update-accelerator --accelerator-arn "$a" --no-enabled
  while :; do
    describe "$i"
    [ $? -eq 1 ] && return 1
    [ "$(jq -r '.Status' <<<"$DJ")" = DEPLOYED ] && [ "$(jq -r '.Enabled' <<<"$DJ")" = false ] && break
    if past_until; then
      warn "left behind: $(label "$i") (still disabling)"
      return 1
    fi
    echo "safety net: waiting for $(label "$i") to finish disabling"
    sleep "$POLL_S"
  done
  if json="$(awsq "$r" globalaccelerator list-listeners --accelerator-arn "$a")"; then
    while IFS= read -r l; do
      [ -z "$l" ] && continue
      while IFS= read -r g; do [ -n "$g" ] && wr "$i" "delete endpoint group ${g##*/} of $(label "$i")" globalaccelerator delete-endpoint-group --endpoint-group-arn "$g"; done < <(awsq "$r" globalaccelerator list-endpoint-groups --listener-arn "$l" | jq -r '.EndpointGroups[]?.EndpointGroupArn // empty')
      wr "$i" "delete listener ${l##*/} of $(label "$i")" globalaccelerator delete-listener --listener-arn "$l"
    done < <(jq -r '.Listeners[]?.ListenerArn // empty' <<<"$json")
  fi
  wr "$i" "delete $(label "$i")" globalaccelerator delete-accelerator --accelerator-arn "$a"
}
# Ruling P10: a web ACL in use by a distribution cannot go, so it follows them; each delete needs the newest lock token.
del_webacl() {
  local i="$1" tok
  describe "$i"
  [ $? -eq 1 ] && return 1
  tok="$(jq -r '.LockToken // empty' <<<"$DJ" 2>/dev/null)"
  wr "$i" "delete $(label "$i")" wafv2 delete-web-acl --scope CLOUDFRONT --name "${C_I[$i]%%/*}" --id "${C_I[$i]#*/}" --lock-token "$tok"
}
# Ruling P23: Resolver. A rule's VPC associations, then the rule; a query log config's associations, then it; a
# firewall rule group's VPC associations (tagged, own handler) and rules, then the group; domain lists; endpoints last,
# each waited for until gone (a VPC cannot be deleted while an endpoint's interfaces are in it).
del_resolver_rule() {
  local i="$1" r="${C_R[$1]}" v
  while IFS= read -r v; do [ -n "$v" ] && wr "$i" "disassociate $(label "$i") from $v" route53resolver disassociate-resolver-rule --resolver-rule-id "${C_I[$i]}" --vpc-id "$v"; done < <(awsq "$r" route53resolver list-resolver-rule-associations --filters "Name=ResolverRuleId,Values=${C_I[$i]}" | jq -r '.ResolverRuleAssociations[]? | select(.Status != "DELETING") | .VPCId // empty')
  wait_until_none "$i" "rule associations" route53resolver list-resolver-rule-associations --filters "Name=ResolverRuleId,Values=${C_I[$i]}" -- '.ResolverRuleAssociations // [] | length' || return 1
  wr "$i" "delete $(label "$i")" route53resolver delete-resolver-rule --resolver-rule-id "${C_I[$i]}"
}
del_querylog() {
  local i="$1" r="${C_R[$1]}" v
  while IFS= read -r v; do [ -n "$v" ] && wr "$i" "disassociate $(label "$i") from $v" route53resolver disassociate-resolver-query-log-config --resolver-query-log-config-id "${C_I[$i]}" --resource-id "$v"; done < <(awsq "$r" route53resolver list-resolver-query-log-config-associations --filters "Name=ResolverQueryLogConfigId,Values=${C_I[$i]}" | jq -r '.ResolverQueryLogConfigAssociations[]? | select(.Status != "DELETING") | .ResourceId // empty')
  wait_until_none "$i" "query log associations" route53resolver list-resolver-query-log-config-associations --filters "Name=ResolverQueryLogConfigId,Values=${C_I[$i]}" -- '[.ResolverQueryLogConfigAssociations[]? | select(.Status != "FAILED")] | length' || return 1
  wr "$i" "delete $(label "$i")" route53resolver delete-resolver-query-log-config --resolver-query-log-config-id "${C_I[$i]}"
}
del_fw_assoc() { wr "$1" "disassociate $(label "$1")" route53resolver disassociate-firewall-rule-group --firewall-rule-group-association-id "${C_I[$1]}"; }
del_fw_group() {
  local i="$1" r="${C_R[$1]}" d
  wait_until_none "$i" "VPC associations" route53resolver list-firewall-rule-group-associations --firewall-rule-group-id "${C_I[$i]}" -- '.FirewallRuleGroupAssociations // [] | length' || return 1
  while IFS= read -r d; do [ -n "$d" ] && wr "$i" "delete the rule for $d in $(label "$i")" route53resolver delete-firewall-rule --firewall-rule-group-id "${C_I[$i]}" --firewall-domain-list-id "$d"; done < <(awsq "$r" route53resolver list-firewall-rules --firewall-rule-group-id "${C_I[$i]}" | jq -r '.FirewallRules[]?.FirewallDomainListId // empty')
  wr "$i" "delete $(label "$i")" route53resolver delete-firewall-rule-group --firewall-rule-group-id "${C_I[$i]}"
}
del_fw_list() { wr "$1" "delete $(label "$1")" route53resolver delete-firewall-domain-list --firewall-domain-list-id "${C_I[$1]}"; }
del_resolver_endpoint() { wr "$1" "delete $(label "$1")" route53resolver delete-resolver-endpoint --resolver-endpoint-id "${C_I[$1]}"; }
# Ruling P23: Lattice. Service associations, VPC associations (waited for), services (their listeners and rules go with
# them), target groups (targets deregistered first), then service networks.
del_sn_svc_assoc() { wr "$1" "delete $(label "$1")" vpc-lattice delete-service-network-service-association --service-network-service-association-identifier "${C_I[$1]}"; }
del_sn_vpc_assoc() { wr "$1" "delete $(label "$1")" vpc-lattice delete-service-network-vpc-association --service-network-vpc-association-identifier "${C_I[$1]}"; }
del_lattice_service() { wr "$1" "delete $(label "$1")" vpc-lattice delete-service --service-identifier "${C_I[$1]}"; }
del_lattice_tg() {
  local i="$1" r="${C_R[$1]}" t
  t="$(awsq "$r" vpc-lattice list-targets --target-group-identifier "${C_I[$i]}" | jq -c '[.items[]? | {id: .id, port: .port}]')"
  [ -n "$t" ] && [ "$t" != "[]" ] && wr "$i" "deregister the targets of $(label "$i")" vpc-lattice deregister-targets --target-group-identifier "${C_I[$i]}" --targets "$t"
  wr "$i" "delete $(label "$i")" vpc-lattice delete-target-group --target-group-identifier "${C_I[$i]}"
}
del_service_network() { wr "$1" "delete $(label "$1")" vpc-lattice delete-service-network --service-network-identifier "${C_I[$1]}"; }
```
with the shared helper:
```bash
# wait_until_none <i> <what> <aws args…> -- <jq count>: poll the listing until the count is 0 (or UNTIL).
wait_until_none() {
  local i="$1" what="$2"; shift 2
  local args=() q n
  while [ "$1" != -- ]; do args+=("$1"); shift; done
  q="$2"
  while :; do
    n="$(awsq "${C_R[$i]}" "${args[@]}" | jq -r "$q" 2>/dev/null)"
    [ "${n:-0}" -eq 0 ] && return 0
    if past_until; then
      warn "left behind: $(label "$i") ($n $what still there)"
      return 1
    fi
    echo "safety net: waiting for $n $what of $(label "$i")"
    sleep "$POLL_S"
  done
}
```
**`distributions`** (ruling P10, M-4): a failed disable no longer `continue`s out of the list; the distribution joins `left` with a flag, and the wait loop retries `update-distribution` (with a fresh `get-distribution-config` ETag) on each pass while `Enabled` is still true.

`HANDLED` gains `globalaccelerator:accelerator wafv2:global/webacl cloudfront:function route53resolver:resolver-endpoint route53resolver:resolver-rule route53resolver:resolver-query-log-config route53resolver:firewall-rule-group route53resolver:firewall-rule-group-association route53resolver:firewall-domain-list vpc-lattice:servicenetwork vpc-lattice:service vpc-lattice:listener vpc-lattice:targetgroup vpc-lattice:servicenetworkvpcassociation vpc-lattice:servicenetworkserviceassociation` (a Lattice listener goes with its service: handled, only judged).

**Run order**, phase 2 (new lines in order; existing ones unchanged):
```bash
# 2 edge and DNS
distributions
run cloudfront:origin-access-control - del_oac
run cloudfront:function - del_function
run globalaccelerator:accelerator poll del_accelerator
run wafv2:global/webacl - del_webacl
run route53:hostedzone - del_zone
run route53:healthcheck - del_healthcheck
run route53resolver:resolver-rule - del_resolver_rule
run route53resolver:resolver-query-log-config - del_querylog
run route53resolver:firewall-rule-group-association poll del_fw_assoc
run route53resolver:firewall-rule-group - del_fw_group
run route53resolver:firewall-domain-list - del_fw_list
run route53resolver:resolver-endpoint poll del_resolver_endpoint
run vpc-lattice:servicenetworkserviceassociation poll del_sn_svc_assoc
run vpc-lattice:servicenetworkvpcassociation poll del_sn_vpc_assoc
run vpc-lattice:service poll del_lattice_service
run vpc-lattice:targetgroup poll del_lattice_tg
run vpc-lattice:servicenetwork - del_service_network
```

- [ ] **Step 1: Write the failing tests** in `scripts/test/lab-aws-cleanup.test.mjs` (batch 3's `ARN3`, `calls3`, `idx`):

```js
const ARNR = (region, svc, rest) => `arn:aws:${svc}:${region}:123456789012:${rest}`;

test("Review Focus 4: Global Accelerator is disabled, waited for, emptied and deleted in us-west-2; the WAF ACL goes after CloudFront", { skip }, () => {
  const ga = "arn:aws:globalaccelerator::123456789012:accelerator/0abc-1def";
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources .*--region us-west-2", out: tagged(ga) },
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources .*--region us-east-1", out: tagged(ARNR("us-east-1", "wafv2", "global/webacl/lab-ans-26-edge-waf/0a1b"), "arn:aws:cloudfront::123456789012:distribution/E1ABC") },
    { cmd: "aws", match: "^globalaccelerator describe-accelerator", out: ['{"Accelerator":{"Enabled":true,"Status":"DEPLOYED"}}', '{"Accelerator":{"Enabled":false,"Status":"IN_PROGRESS"}}', '{"Accelerator":{"Enabled":false,"Status":"DEPLOYED"}}'] },
    { cmd: "aws", match: "^globalaccelerator list-listeners", out: `{"Listeners":[{"ListenerArn":"${ga}/listener/l1"}]}` },
    { cmd: "aws", match: "^globalaccelerator list-endpoint-groups", out: `{"EndpointGroups":[{"EndpointGroupArn":"${ga}/listener/l1/endpoint-group/g1"},{"EndpointGroupArn":"${ga}/listener/l1/endpoint-group/g2"}]}` },
    { cmd: "aws", match: "^cloudfront get-distribution-config", out: '{"ETag":"E1","DistributionConfig":{"Enabled":false}}' },
    { cmd: "aws", match: "^cloudfront get-distribution --id", out: ['{"ETag":"E2","Distribution":{"Status":"Deployed","DistributionConfig":{"Enabled":false}}}', "{}"] },
    { cmd: "aws", match: "^wafv2 get-web-acl", out: '{"LockToken":"tok-1","WebACL":{}}' },
    { cmd: "aws", match: "^cloudfront list-functions", out: '{"FunctionList":{"Items":[{"Name":"lab-ans-26-edge-headers"},{"Name":"someone-else"}]}}' },
    { cmd: "aws", match: "^cloudfront describe-function", out: '{"ETag":"EF1"}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["ans-26-edge"], { ...ENV, LAB_REGIONS: "eu-west-2 eu-west-1 us-east-1 us-west-2" }).status, 0);
  const ws = calls3(w, /^aws (globalaccelerator|wafv2|cloudfront) (update|delete)/);
  const at = (re) => idx(ws, re);
  assert.ok(at(/^aws globalaccelerator update-accelerator .*--no-enabled --region us-west-2$/) >= 0, ws.join("\n"));
  assert.ok(at(/delete-endpoint-group .*g1 --region us-west-2$/) < at(/delete-listener .*l1 --region us-west-2$/));
  assert.ok(at(/delete-listener/) < at(/^aws globalaccelerator delete-accelerator .*--region us-west-2$/));
  assert.ok(at(/^aws cloudfront delete-distribution/) < at(/^aws wafv2 delete-web-acl --scope CLOUDFRONT --name lab-ans-26-edge-waf --id 0a1b --lock-token tok-1 --region us-east-1$/));
  assert.ok(at(/^aws cloudfront delete-distribution/) < at(/^aws cloudfront delete-function --name lab-ans-26-edge-headers --if-match EF1/));
  assert.ok(!ws.some((c) => c.includes("someone-else")));
  w.cleanup();
});

test("ruling P10 (M-4): a CloudFront disable that failed is retried on the next pass", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources .*--region us-east-1", out: tagged("arn:aws:cloudfront::123456789012:distribution/E1ABC") },
    { cmd: "aws", match: "^cloudfront get-distribution-config", out: '{"ETag":"E1","DistributionConfig":{"Enabled":true}}' },
    { cmd: "aws", match: "^cloudfront update-distribution", out: ["", "{}"], code: [254, 0], err: ["An error occurred (PreconditionFailed) when calling the UpdateDistribution operation: x", ""] },
    { cmd: "aws", match: "^cloudfront get-distribution --id", out: ['{"ETag":"E2","Distribution":{"Status":"InProgress","DistributionConfig":{"Enabled":true}}}', '{"ETag":"E3","Distribution":{"Status":"Deployed","DistributionConfig":{"Enabled":false}}}', "{}"] },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["ans-26-edge"], { ...ENV, LAB_REGIONS: "eu-west-2 us-east-1" }).status, 0);
  assert.equal(calls3(w, /^aws cloudfront update-distribution/).length, 2);
  assert.ok(calls3(w, /^aws cloudfront delete-distribution --id E1ABC --if-match E3/).length === 1);
  w.cleanup();
});

test("Review Focus 4: Resolver's associations, rules, firewall rules and endpoints in order", { skip }, () => {
  const R = (rest) => ARN3("route53resolver", rest);
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(R("resolver-rule/rslvr-rr-1"), R("resolver-query-log-config/rslvr-qlc-1"), R("firewall-rule-group-association/rslvr-frgassoc-1"), R("firewall-rule-group/rslvr-frg-1"), R("firewall-domain-list/rslvr-fdl-1"), R("resolver-endpoint/rslvr-in-1"), R("resolver-endpoint/rslvr-out-1")) },
    { cmd: "aws", match: "^route53resolver list-resolver-rule-associations", out: ['{"ResolverRuleAssociations":[{"VPCId":"vpc-0lab","Status":"COMPLETE"}]}', '{"ResolverRuleAssociations":[]}'] },
    { cmd: "aws", match: "^route53resolver list-resolver-query-log-config-associations", out: ['{"ResolverQueryLogConfigAssociations":[{"ResourceId":"vpc-0lab","Status":"ACTIVE"}]}', '{"ResolverQueryLogConfigAssociations":[]}'] },
    { cmd: "aws", match: "^route53resolver list-firewall-rule-group-associations", out: '{"FirewallRuleGroupAssociations":[]}' },
    { cmd: "aws", match: "^route53resolver list-firewall-rules", out: '{"FirewallRules":[{"FirewallDomainListId":"rslvr-fdl-1"}]}' },
    { cmd: "aws", match: "^route53resolver get-firewall-rule-group-association", out: ['{"FirewallRuleGroupAssociation":{"Status":"DELETING"}}', "{}"] },
    { cmd: "aws", match: "^route53resolver get-resolver-endpoint", out: ['{"ResolverEndpoint":{"Status":"DELETING"}}', "{}"] },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["ans-23-hybrid-dns"], ENV).status, 0);
  const ws = calls3(w, /^aws route53resolver (disassociate|delete)/).map((c) => c.split(" --region")[0]);
  const at = (s) => ws.indexOf(s);
  assert.ok(at("aws route53resolver disassociate-resolver-rule --resolver-rule-id rslvr-rr-1 --vpc-id vpc-0lab") < at("aws route53resolver delete-resolver-rule --resolver-rule-id rslvr-rr-1"), ws.join("\n"));
  assert.ok(at("aws route53resolver disassociate-resolver-query-log-config --resolver-query-log-config-id rslvr-qlc-1 --resource-id vpc-0lab") < at("aws route53resolver delete-resolver-query-log-config --resolver-query-log-config-id rslvr-qlc-1"));
  assert.ok(at("aws route53resolver disassociate-firewall-rule-group --firewall-rule-group-association-id rslvr-frgassoc-1") < at("aws route53resolver delete-firewall-rule --firewall-rule-group-id rslvr-frg-1 --firewall-domain-list-id rslvr-fdl-1"));
  assert.ok(at("aws route53resolver delete-firewall-rule-group --firewall-rule-group-id rslvr-frg-1") < at("aws route53resolver delete-firewall-domain-list --firewall-domain-list-id rslvr-fdl-1"));
  assert.ok(at("aws route53resolver delete-firewall-domain-list --firewall-domain-list-id rslvr-fdl-1") < at("aws route53resolver delete-resolver-endpoint --resolver-endpoint-id rslvr-in-1"));
  w.cleanup();
});

test("ruling P23: Lattice associations, then services, target groups (targets first), then the network", { skip }, () => {
  const L = (rest) => ARN3("vpc-lattice", rest);
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(L("servicenetwork/sn-1"), L("service/svc-1"), L("service/svc-1/listener/listener-1"), L("targetgroup/tg-1"), L("servicenetworkvpcassociation/snva-1"), L("servicenetworkserviceassociation/snsa-1")) },
    { cmd: "aws", match: "^vpc-lattice get-service-network-vpc-association", out: ['{"status":"DELETE_IN_PROGRESS"}', "{}"] },
    { cmd: "aws", match: "^vpc-lattice get-service-network-service-association", out: ['{"status":"DELETE_IN_PROGRESS"}', "{}"] },
    { cmd: "aws", match: "^vpc-lattice get-service --", out: ['{"status":"DELETE_IN_PROGRESS"}', "{}"] },
    { cmd: "aws", match: "^vpc-lattice get-target-group", out: ['{"status":"DELETE_IN_PROGRESS"}', "{}"] },
    { cmd: "aws", match: "^vpc-lattice list-targets", out: '{"items":[{"id":"i-0abc","port":80}]}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["ans-30-vpc-lattice"], ENV).status, 0);
  const ws = calls3(w, /^aws vpc-lattice (delete|deregister)/).map((c) => c.split(" --region")[0].split(" ").slice(0, 3).join(" "));
  assert.deepEqual(ws, ["aws vpc-lattice delete-service-network-service-association", "aws vpc-lattice delete-service-network-vpc-association", "aws vpc-lattice delete-service", "aws vpc-lattice deregister-targets", "aws vpc-lattice delete-target-group", "aws vpc-lattice delete-service-network"]);
  assert.ok(!calls3(w, /delete-listener/).length, "a listener goes with its service");
  w.cleanup();
});
```
In `scripts/test/aws-labs-iam.test.mjs`'s CLI-coverage test: `SERVICES_RE` gains `globalaccelerator|wafv2|route53resolver|vpc-lattice` (`cloudfront` is there); `CLI_SERVICE` is unchanged for them; the `must` list gains `"globalaccelerator update-accelerator", "globalaccelerator delete-accelerator", "globalaccelerator delete-endpoint-group", "globalaccelerator delete-listener", "wafv2 delete-web-acl", "cloudfront delete-function", "route53resolver delete-resolver-rule", "route53resolver disassociate-resolver-rule", "route53resolver delete-resolver-endpoint", "route53resolver delete-firewall-rule", "vpc-lattice delete-service", "vpc-lattice deregister-targets", "vpc-lattice delete-service-network"`; `requestsOf` signs `globalaccelerator` in us-west-2 and `wafv2 … --scope CLOUDFRONT` in us-east-1; `calls.length > 130` becomes `> 160`.

- [ ] **Step 2: Run them to make sure they fail**
Run: `node --test scripts/test/lab-aws-cleanup.test.mjs scripts/test/aws-labs-iam.test.mjs`
Expected: FAIL (no handlers; "no handler for globalaccelerator:accelerator yet"; one disable attempt only).

- [ ] **Step 3: Write the changes** above; `bash -n infra/ci/lab-aws-safety-net.sh`.

- [ ] **Step 4: Run the targeted tests** (in docker `node:24-bookworm` with `apt-get install -y jq` if jq is missing here; CI runs them natively)
Run: `node --test scripts/test/lab-aws-cleanup.test.mjs scripts/test/aws-labs-iam.test.mjs`
Expected: PASS (every earlier clean-up test unchanged; batch 2's CloudFront test still sees one disable).

- [ ] **Step 5: Commit**
```bash
git add infra/ci/lab-aws-safety-net.sh scripts/test/lab-aws-cleanup.test.mjs scripts/test/aws-labs-iam.test.mjs
git commit -m "feat(aws labs): clean-up for batch 4's edge, DNS and Lattice: Global Accelerator in us-west-2, WAF after CloudFront, functions by name, Resolver and Lattice in dependency order; CloudFront disables retried

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---

### Task 6: Clean-up II: network services (Client VPN, Network Firewall, endpoint services, mirroring, VPN, transit gateways, IPAM, ACM), Unblock, ready check

Spec: §5.1, §8.1–§8.3; rulings A26, A36, A53, A106, P3, P5, P15–P17, P20, P23, P26.

**Files:**
- Modify: `infra/ci/lab-aws-safety-net.sh` (`describe`, `judge`, handlers, `HANDLED`, phases 3 and 4's run order, header)
- Modify: `infra/ci/lab-unblock-aws.sh` (header only: names what batch 4 relies on, P26)
- Modify: `infra/ci/lab-ready-aws.sh` (an ACM certificate `ISSUED`; a peering attachment `pendingAcceptance` waited for; header)
- Test: `scripts/test/lab-aws-cleanup.test.mjs`, `scripts/test/lab-aws-pipeline.test.mjs`, `scripts/test/aws-labs-iam.test.mjs`

**Interfaces:**
- Consumes: Task 2's policies; Task 5's `wait_until_none`. Produces nothing other tasks call.

**`describe`** gains:
```bash
    ec2:client-vpn-endpoint) set -- ec2 describe-client-vpn-endpoints --client-vpn-endpoint-ids "$id"; q='.ClientVpnEndpoints[]?' ;;
    network-firewall:firewall) set -- network-firewall describe-firewall --firewall-arn "$x"; q='.Firewall' ;;
    network-firewall:firewall-policy) set -- network-firewall describe-firewall-policy --firewall-policy-arn "$x"; q='.FirewallPolicyResponse' ;;
    network-firewall:stateful-rulegroup|network-firewall:stateless-rulegroup) set -- network-firewall describe-rule-group --rule-group-arn "$x"; q='.RuleGroupResponse' ;;
    ec2:vpc-endpoint-service) set -- ec2 describe-vpc-endpoint-service-configurations --service-ids "$id"; q='.ServiceConfigurations[]?' ;;
    ec2:traffic-mirror-session) set -- ec2 describe-traffic-mirror-sessions --traffic-mirror-session-ids "$id"; q='.TrafficMirrorSessions[]?' ;;
    ec2:traffic-mirror-target) set -- ec2 describe-traffic-mirror-targets --traffic-mirror-target-ids "$id"; q='.TrafficMirrorTargets[]?' ;;
    ec2:traffic-mirror-filter) set -- ec2 describe-traffic-mirror-filters --traffic-mirror-filter-ids "$id"; q='.TrafficMirrorFilters[]?' ;;
    ec2:vpn-connection) set -- ec2 describe-vpn-connections --vpn-connection-ids "$id"; q='.VpnConnections[]?' ;;
    ec2:vpn-gateway) set -- ec2 describe-vpn-gateways --vpn-gateway-ids "$id"; q='.VpnGateways[]?' ;;
    ec2:customer-gateway) set -- ec2 describe-customer-gateways --customer-gateway-ids "$id"; q='.CustomerGateways[]?' ;;
    ec2:transit-gateway) set -- ec2 describe-transit-gateways --transit-gateway-ids "$id"; q='.TransitGateways[]?' ;;
    ec2:transit-gateway-attachment) set -- ec2 describe-transit-gateway-attachments --transit-gateway-attachment-ids "$id"; q='.TransitGatewayAttachments[]?' ;;
    ec2:transit-gateway-route-table) set -- ec2 describe-transit-gateway-route-tables --transit-gateway-route-table-ids "$id"; q='.TransitGatewayRouteTables[]?' ;;
    ec2:ipam) set -- ec2 describe-ipams --ipam-ids "$id"; q='.Ipams[]?' ;;
    ec2:ipam-pool) set -- ec2 describe-ipam-pools --ipam-pool-ids "$id"; q='.IpamPools[]?' ;;
    ec2:ipam-scope) set -- ec2 describe-ipam-scopes --ipam-scope-ids "$id"; q='.IpamScopes[]?' ;;
    acm:certificate) set -- acm describe-certificate --certificate-arn "$x"; q='.Certificate' ;;
```
**`judge`** gains (ruling P23: these cannot be stopped once deleting, and the tagging API keeps listing them):
```bash
    ec2:client-vpn-endpoint) g='(.Status.Code // "") | IN("deleting", "deleted")' ;;
    ec2:vpn-connection|ec2:vpn-gateway|ec2:customer-gateway) g='(.State // "") | IN("deleting", "deleted")' ;;
    ec2:transit-gateway|ec2:transit-gateway-attachment|ec2:transit-gateway-route-table) g='(.State // "") | IN("deleting", "deleted", "rejected", "failed")' ;;
    ec2:ipam|ec2:ipam-pool|ec2:ipam-scope) g='(.State // "") | IN("delete-in-progress", "delete-complete")' ;;
    ec2:vpc-endpoint-service) g='(.ServiceState // "" | ascii_downcase) | IN("deleting", "deleted")' ;;
```
(A Network Firewall, policy or rule group, a mirror item or an ACM certificate is there until AWS no longer has it.)

**Handlers** (phase 3 unless named):
```bash
# Ruling P20: Client VPN: every target network disassociated and waited for, then the endpoint.
del_cvpn() {
  local i="$1" r="${C_R[$1]}" a
  while IFS= read -r a; do [ -n "$a" ] && wr "$i" "disassociate $a from $(label "$i")" ec2 disassociate-client-vpn-target-network --client-vpn-endpoint-id "${C_I[$i]}" --association-id "$a"; done < <(awsq "$r" ec2 describe-client-vpn-target-networks --client-vpn-endpoint-id "${C_I[$i]}" | jq -r '.ClientVpnTargetNetworks[]? | select(.Status.Code != "disassociating") | .AssociationId // empty')
  wait_until_none "$i" "target networks" ec2 describe-client-vpn-target-networks --client-vpn-endpoint-id "${C_I[$i]}" -- '.ClientVpnTargetNetworks // [] | length' || return 1
  wr "$i" "delete $(label "$i")" ec2 delete-client-vpn-endpoint --client-vpn-endpoint-id "${C_I[$i]}"
}
# Ruling P16 / P23: a firewall is deleted and waited for until gone (its endpoints hold the subnet); then policies and
# rule groups (AWS refuses one still in use).
del_nfw() { wr "$1" "delete $(label "$1")" network-firewall delete-firewall --firewall-arn "${C_A[$1]}"; }
del_nfw_policy() { wr "$1" "delete $(label "$1")" network-firewall delete-firewall-policy --firewall-policy-arn "${C_A[$1]}"; }
del_nfw_group() { wr "$1" "delete $(label "$1")" network-firewall delete-rule-group --rule-group-arn "${C_A[$1]}"; }
# Ruling P23: an endpoint service's own connected endpoints (the lab's, in its candidates) are deleted and waited for,
# then the service; both before load balancers, which AWS will not delete while a service names them.
del_vpce_svc() {
  local i="$1" r="${C_R[$1]}" e j
  while IFS= read -r e; do
    [ -z "$e" ] && continue
    j="$(of_id ec2:vpc-endpoint "$e")"
    if [ -n "$j" ]; then wr "$j" "delete $(label "$j"), connected to $(label "$i")" ec2 delete-vpc-endpoints --vpc-endpoint-ids "$e"
    else wr "$i" "reject endpoint $e on $(label "$i")" ec2 reject-vpc-endpoint-connections --service-id "${C_I[$i]}" --vpc-endpoint-ids "$e"; fi
  done < <(awsq "$r" ec2 describe-vpc-endpoint-connections --filters "Name=service-id,Values=${C_I[$i]}" | jq -r '.VpcEndpointConnections[]? | select((.VpcEndpointState // "" | ascii_downcase) | IN("deleted", "deleting", "rejected") | not) | .VpcEndpointId // empty')
  wait_until_none "$i" "connected endpoints" ec2 describe-vpc-endpoint-connections --filters "Name=service-id,Values=${C_I[$i]}" -- '[.VpcEndpointConnections[]? | select((.VpcEndpointState // "" | ascii_downcase) | IN("deleted", "rejected") | not)] | length' || return 1
  wr "$i" "delete $(label "$i")" ec2 delete-vpc-endpoint-service-configurations --service-ids "${C_I[$i]}"
}
# Ruling P17: mirror sessions (a hand-made, tagged one) before targets and filters.
del_mirror_session() { wr "$1" "delete $(label "$1")" ec2 delete-traffic-mirror-session --traffic-mirror-session-id "${C_I[$1]}"; }
del_mirror_target() { wr "$1" "delete $(label "$1")" ec2 delete-traffic-mirror-target --traffic-mirror-target-id "${C_I[$1]}"; }
del_mirror_filter() { wr "$1" "delete $(label "$1")" ec2 delete-traffic-mirror-filter --traffic-mirror-filter-id "${C_I[$1]}"; }
# VPN: connections (waited for), virtual private gateways (detached, waited for, deleted), customer gateways.
del_vpn() { wr "$1" "delete $(label "$1")" ec2 delete-vpn-connection --vpn-connection-id "${C_I[$1]}"; }
del_vgw() {
  local i="$1" v
  describe "$i"
  [ $? -eq 1 ] && return 1
  while IFS= read -r v; do [ -n "$v" ] && vpc_ok "$i" && wr "$i" "detach $(label "$i") from $v" ec2 detach-vpn-gateway --vpn-gateway-id "${C_I[$i]}" --vpc-id "$v"; done < <(jq -r '.VpcAttachments[]? | select(.State == "attached" or .State == "attaching") | .VpcId // empty' <<<"$DJ")
  wait_until_none "$i" "VPC attachments" ec2 describe-vpn-gateways --vpn-gateway-ids "${C_I[$i]}" -- '[.VpnGateways[]?.VpcAttachments[]? | select(.State != "detached")] | length' || return 1
  wr "$i" "delete $(label "$i")" ec2 delete-vpn-gateway --vpn-gateway-id "${C_I[$i]}"
}
del_cgw() { wr "$1" "delete $(label "$1")" ec2 delete-customer-gateway --customer-gateway-id "${C_I[$1]}"; }
# Ruling P15 / P3: transit gateway attachments (VPC and peering; a peering seen in both regions is deleted once, the
# second answer being gone), then non-default route tables, then transit gateways; each waited for.
del_tgw_attachment() {
  local i="$1" kind
  describe "$i"
  [ $? -eq 1 ] && return 1
  case "$(jq -r '.State // ""' <<<"$DJ")" in deleting | deleted) return 0 ;; esac
  kind="$(jq -r '.ResourceType // ""' <<<"$DJ")"
  case "$kind" in
    vpc) wr "$i" "delete $(label "$i")" ec2 delete-transit-gateway-vpc-attachment --transit-gateway-attachment-id "${C_I[$i]}" ;;
    peering) wr "$i" "delete $(label "$i")" ec2 delete-transit-gateway-peering-attachment --transit-gateway-attachment-id "${C_I[$i]}" ;;
    *) warn "left behind: $(label "$i") (a $kind attachment; no lab makes one)"; return 1 ;;
  esac
}
del_tgw_rt() {
  local i="$1"
  describe "$i"
  [ $? -eq 1 ] && return 1
  [ "$(jq -r '.DefaultAssociationRouteTable' <<<"$DJ")" = true ] && return 1   # goes with its transit gateway
  wr "$i" "delete $(label "$i")" ec2 delete-transit-gateway-route-table --transit-gateway-route-table-id "${C_I[$i]}"
}
del_tgw() { wr "$1" "delete $(label "$1")" ec2 delete-transit-gateway --transit-gateway-id "${C_I[$1]}"; }
# Phase 4, after the fabric (ruling P5 / P23): IPAM with --cascade (its pools, scopes and provisioned CIDRs with it);
# a pool or scope found on its own is judged only.
del_ipam() { wr "$1" "delete $(label "$1") and its pools" ec2 delete-ipam --ipam-id "${C_I[$1]}" --cascade; }
# Phase 5: an imported certificate stays "in use" for minutes after its load balancer or Client VPN endpoint goes.
del_cert() {
  local i="$1"
  while :; do
    if awsx acm delete-certificate --certificate-arn "${C_A[$i]}" --region "${C_R[$i]}" >/dev/null; then echo "safety net: deleted $(label "$i")"; return 0; fi
    gone_err && return 0
    [ "$(errcode)" != ResourceInUseException ] && { warn "could not delete $(label "$i") ($(code))"; return 1; }
    if past_until; then warn "left behind: $(label "$i") (still in use)"; return 1; fi
    echo "safety net: waiting for $(label "$i") to be free"
    sleep "$POLL_S"
  done
}
```
(`of_id <type> <id>` returns the candidate index of that type and id, or nothing; add it beside `of_type` if absent.)

`HANDLED` gains `ec2:client-vpn-endpoint network-firewall:firewall network-firewall:firewall-policy network-firewall:stateful-rulegroup network-firewall:stateless-rulegroup ec2:vpc-endpoint-service ec2:traffic-mirror-session ec2:traffic-mirror-target ec2:traffic-mirror-filter ec2:vpn-connection ec2:vpn-gateway ec2:customer-gateway ec2:transit-gateway ec2:transit-gateway-attachment ec2:transit-gateway-route-table ec2:ipam ec2:ipam-pool ec2:ipam-scope acm:certificate` (pools and scopes go with their IPAM: handled, only judged).

**Run order**, phases 3–5 (new lines in their places; existing ones unchanged):
```bash
# 3 network services
run ec2:client-vpn-endpoint poll del_cvpn
run network-firewall:firewall poll del_nfw
run network-firewall:firewall-policy - del_nfw_policy
run network-firewall:stateful-rulegroup - del_nfw_group
run network-firewall:stateless-rulegroup - del_nfw_group
run ec2:vpc-endpoint-service poll del_vpce_svc
run elasticloadbalancing:loadbalancer poll del_lb
…(listeners … EFS: unchanged)…
run ec2:traffic-mirror-session - del_mirror_session
run ec2:traffic-mirror-target - del_mirror_target
run ec2:traffic-mirror-filter - del_mirror_filter
run ec2:instance poll del_instance
…(launch templates, NAT gateways, Elastic IPs: unchanged)…
run ec2:vpn-connection poll del_vpn
run ec2:vpn-gateway poll del_vgw
run ec2:customer-gateway - del_cgw
run ec2:transit-gateway-attachment poll del_tgw_attachment
run ec2:transit-gateway-route-table poll del_tgw_rt
run ec2:transit-gateway poll del_tgw
run ec2:vpc-peering-connection - del_pcx
…(VPC endpoints … flow logs: unchanged)…
# 4 VPC fabric, then IPAM
fabric
run ec2:security-group-rule - del_sgr
run ec2:ipam poll del_ipam
# 5 data and the rest: acm:certificate after the buckets
run acm:certificate - del_cert
```

**`infra/ci/lab-ready-aws.sh`**: gains
```bash
    acm:certificate)
      json="$(awsq acm describe-certificate --certificate-arn "$arn" --region "$region")" || { unanswered; return; }
      judge "$(jq -r '.Certificate.Status // ""' <<<"$json")" ISSUED FAILED ;;
```
and in `ec2:transit-gateway-attachment)`: `[ "$s" = pendingAcceptance ] && s=pending` (waited for, never failed: lab 29's accept follows at once). Its header names both. **`infra/ci/lab-unblock-aws.sh`**: header only, "batch 4 (ruling P26): Network Firewall delete protection and Client VPN connections are already here; no batch 4 Lambda runs in a VPC, so the Lambda interface wait stays as it is".

- [ ] **Step 1: Write the failing tests** in `scripts/test/lab-aws-cleanup.test.mjs`:

```js
test("Review Focus 4: endpoint services and their endpoints go before load balancers", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("ec2", "vpc-endpoint-service/vpce-svc-0abc"), ARN3("ec2", "vpc-endpoint/vpce-0lab"), ARN3("elasticloadbalancing", "loadbalancer/net/nlb-a24k3x9q/0abc")) },
    { cmd: "aws", match: "^ec2 describe-vpc-endpoint-connections", out: ['{"VpcEndpointConnections":[{"VpcEndpointId":"vpce-0lab","VpcEndpointState":"available"},{"VpcEndpointId":"vpce-0theirs","VpcEndpointState":"available"}]}', '{"VpcEndpointConnections":[]}', '{"VpcEndpointConnections":[]}'] },
    { cmd: "aws", match: "^ec2 describe-vpc-endpoint-service-configurations", out: ['{"ServiceConfigurations":[{"ServiceState":"Deleting"}]}', "{}"] },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", out: ['{"LoadBalancers":[{"State":{"Code":"active"}}]}', "{}"] },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["ans-24-privatelink"], ENV).status, 0);
  const ws = calls3(w, /^aws (ec2|elbv2) (delete|reject)/).map((c) => c.split(" --region")[0]);
  const at = (s) => ws.findIndex((c) => c.startsWith(s));
  assert.ok(at("aws ec2 delete-vpc-endpoints --vpc-endpoint-ids vpce-0lab") < at("aws ec2 delete-vpc-endpoint-service-configurations --service-ids vpce-svc-0abc"), ws.join("\n"));
  assert.ok(at("aws ec2 reject-vpc-endpoint-connections --service-id vpce-svc-0abc --vpc-endpoint-ids vpce-0theirs") >= 0, "another's endpoint is only rejected");
  assert.ok(at("aws ec2 delete-vpc-endpoint-service-configurations") < at("aws elbv2 delete-load-balancer"));
  w.cleanup();
});

test("Review Focus 4: VPN connections, gateways, attachments, route tables, then transit gateways", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("ec2", "vpn-connection/vpn-0a"), ARN3("ec2", "vpn-gateway/vgw-0a"), ARN3("ec2", "customer-gateway/cgw-0a"), ARN3("ec2", "transit-gateway/tgw-0a"), ARN3("ec2", "transit-gateway-attachment/tgw-attach-0v"), ARN3("ec2", "transit-gateway-attachment/tgw-attach-0p"), ARN3("ec2", "transit-gateway-route-table/tgw-rtb-0s"), ARN3("ec2", "transit-gateway-route-table/tgw-rtb-0d")) },
    { cmd: "aws", match: "^ec2 describe-vpn-connections", out: ['{"VpnConnections":[{"State":"deleting"}]}', '{"VpnConnections":[{"State":"deleted"}]}'] },
    { cmd: "aws", match: "^ec2 describe-vpn-gateways", out: ['{"VpnGateways":[{"State":"available","VpcAttachments":[{"VpcId":"vpc-0lab","State":"attached"}]}]}', '{"VpnGateways":[{"VpcAttachments":[{"VpcId":"vpc-0lab","State":"detached"}]}]}', '{"VpnGateways":[{"State":"deleted"}]}'] },
    { cmd: "aws", match: "^ec2 describe-transit-gateway-attachments --transit-gateway-attachment-ids tgw-attach-0v", out: ['{"TransitGatewayAttachments":[{"State":"available","ResourceType":"vpc"}]}', '{"TransitGatewayAttachments":[{"State":"deleted"}]}'] },
    { cmd: "aws", match: "^ec2 describe-transit-gateway-attachments --transit-gateway-attachment-ids tgw-attach-0p", out: ['{"TransitGatewayAttachments":[{"State":"available","ResourceType":"peering"}]}', '{"TransitGatewayAttachments":[{"State":"deleted"}]}'] },
    { cmd: "aws", match: "^ec2 describe-transit-gateway-route-tables --transit-gateway-route-table-ids tgw-rtb-0s", out: ['{"TransitGatewayRouteTables":[{"State":"available","DefaultAssociationRouteTable":false}]}', '{"TransitGatewayRouteTables":[{"State":"deleted"}]}'] },
    { cmd: "aws", match: "^ec2 describe-transit-gateway-route-tables --transit-gateway-route-table-ids tgw-rtb-0d", out: '{"TransitGatewayRouteTables":[{"State":"available","DefaultAssociationRouteTable":true}]}' },
    { cmd: "aws", match: "^ec2 describe-transit-gateways", out: ['{"TransitGateways":[{"State":"deleting"}]}', '{"TransitGateways":[{"State":"deleted"}]}'] },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["ans-21-transit-gateway"], ENV).status, 0);
  const ws = calls3(w, /^aws ec2 (delete|detach)-(vpn|customer|transit)/).map((c) => c.split(" --region")[0].split(" ").slice(0, 3).join(" "));
  assert.deepEqual(ws, ["aws ec2 delete-vpn-connection", "aws ec2 detach-vpn-gateway", "aws ec2 delete-vpn-gateway", "aws ec2 delete-customer-gateway", "aws ec2 delete-transit-gateway-vpc-attachment", "aws ec2 delete-transit-gateway-peering-attachment", "aws ec2 delete-transit-gateway-route-table", "aws ec2 delete-transit-gateway"]);
  w.cleanup();
});

test("Review Focus 4: Network Firewall is waited for until gone; IPAM is cascaded after the fabric; Client VPN networks go first", { skip }, () => {
  const fw = ARN3("network-firewall", "firewall/lab-ans-27-network-firewall");
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(fw, ARN3("network-firewall", "firewall-policy/lab-x-policy"), ARN3("ec2", "vpc/vpc-0insp"), "arn:aws:ec2::123456789012:ipam/ipam-0abc", ARN3("ec2", "client-vpn-endpoint/cvpn-endpoint-0a")) },
    { cmd: "aws", match: "^network-firewall describe-firewall ", out: ['{"Firewall":{}}', '{"Firewall":{}}', ""], code: [0, 0, 254], err: ["", "", "An error occurred (ResourceNotFoundException) when calling the DescribeFirewall operation: x"] },
    { cmd: "aws", match: "^ec2 describe-client-vpn-target-networks", out: ['{"ClientVpnTargetNetworks":[{"AssociationId":"cvpn-assoc-1","Status":{"Code":"associated"}}]}', '{"ClientVpnTargetNetworks":[]}'] },
    { cmd: "aws", match: "^ec2 describe-client-vpn-endpoints", out: ['{"ClientVpnEndpoints":[{"Status":{"Code":"deleting"}}]}'] },
    { cmd: "aws", match: "^ec2 describe-ipams", out: ['{"Ipams":[{"State":"delete-in-progress"}]}'] },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["ans-27-network-firewall"], ENV).status, 0);
  const all = w.calls();
  const at = (re) => all.findIndex((c) => re.test(c));
  assert.ok(at(/^aws ec2 disassociate-client-vpn-target-network .*cvpn-assoc-1/) < at(/^aws ec2 delete-client-vpn-endpoint/));
  assert.ok(at(/^aws network-firewall delete-firewall /) < at(/^aws network-firewall delete-firewall-policy/));
  assert.ok(all.filter((c) => c.startsWith("aws network-firewall describe-firewall ")).length >= 3, "waited until gone");
  assert.ok(at(/^aws ec2 delete-vpc --vpc-id vpc-0insp/) < at(/^aws ec2 delete-ipam --ipam-id ipam-0abc --cascade/));
  w.cleanup();
});

test("ruling P23: Verify clean counts batch 4's deleting items clean; a firewall or certificate still there is a leftover", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("ec2", "transit-gateway/tgw-0a"), ARN3("ec2", "vpn-connection/vpn-0a"), "arn:aws:ec2::123456789012:ipam/ipam-0a", ARN3("network-firewall", "firewall/lab-x"), ARN3("acm", "certificate/c1")) },
    { cmd: "aws", match: "^ec2 describe-transit-gateways", out: '{"TransitGateways":[{"State":"deleting"}]}' },
    { cmd: "aws", match: "^ec2 describe-vpn-connections", out: '{"VpnConnections":[{"State":"deleted"}]}' },
    { cmd: "aws", match: "^ec2 describe-ipams", out: '{"Ipams":[{"State":"delete-in-progress"}]}' },
    { cmd: "aws", match: "^network-firewall describe-firewall", out: '{"Firewall":{"FirewallName":"lab-x"},"FirewallStatus":{"Status":"DELETING"}}' },
    { cmd: "aws", match: "^acm describe-certificate", out: '{"Certificate":{"Status":"ISSUED"}}' },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", "ans-27-network-firewall"], { ...ENV, GITHUB_OUTPUT: fwd(out) }).status, 1);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.deepEqual(left.sort(), ["acm:certificate c1", "network-firewall:firewall lab-x"]);
  w.cleanup();
});
```
In `scripts/test/lab-aws-pipeline.test.mjs`:
```js
test("the ready check waits for a peering attachment pending acceptance and an ACM certificate ISSUED", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: JSON.stringify({ ResourceTagMappingList: [{ ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:transit-gateway-attachment/tgw-attach-0p" }, { ResourceARN: "arn:aws:acm:eu-west-2:123456789012:certificate/c1" }] }) },
    { cmd: "aws", match: "^ec2 describe-transit-gateway-attachments", out: ['{"TransitGatewayAttachments":[{"State":"pendingAcceptance"}]}', '{"TransitGatewayAttachments":[{"State":"available"}]}'] },
    { cmd: "aws", match: "^acm describe-certificate", out: '{"Certificate":{"Status":"ISSUED"}}' },
  ]);
  const r = w.run("infra/ci/lab-ready-aws.sh", ["ans-29-multi-region", "5"], { LAB_REGIONS: "eu-west-2", LAB_READY_POLL_SECONDS: "0" });
  assert.equal(r.status, 0, r.out);
  assert.equal(w.calls().filter((c) => c.startsWith("aws ec2 describe-transit-gateway-attachments")).length, 2);
  w.cleanup();
});
```
In `scripts/test/aws-labs-iam.test.mjs`'s CLI-coverage test: `SERVICES_RE` gains `network-firewall|acm`; the `must` list gains `"ec2 delete-client-vpn-endpoint", "ec2 disassociate-client-vpn-target-network", "network-firewall delete-firewall", "ec2 delete-vpc-endpoint-service-configurations", "ec2 reject-vpc-endpoint-connections", "ec2 delete-traffic-mirror-target", "ec2 delete-vpn-connection", "ec2 detach-vpn-gateway", "ec2 delete-transit-gateway-peering-attachment", "ec2 delete-transit-gateway", "ec2 delete-ipam", "acm delete-certificate"`; `calls.length > 160` becomes `> 185`.

- [ ] **Step 2: Run them to make sure they fail**
Run: `node --test scripts/test/lab-aws-cleanup.test.mjs scripts/test/lab-aws-pipeline.test.mjs scripts/test/aws-labs-iam.test.mjs`
Expected: FAIL (no handlers for the new types; the load balancer goes before the endpoint service; the attachment `pendingAcceptance` is not known).

- [ ] **Step 3: Write the scripts' changes** above; `bash -n` all three scripts.

- [ ] **Step 4: Run the targeted tests** (docker `node:24-bookworm` with jq where jq is missing)
Run: the Step 2 command
Expected: PASS (every earlier clean-up, pipeline and IAM test unchanged).

- [ ] **Step 5: Commit**
```bash
git add infra/ci/lab-aws-safety-net.sh infra/ci/lab-unblock-aws.sh infra/ci/lab-ready-aws.sh scripts/test/lab-aws-cleanup.test.mjs scripts/test/lab-aws-pipeline.test.mjs scripts/test/aws-labs-iam.test.mjs
git commit -m "feat(aws labs): clean-up for batch 4's network services: Client VPN, Network Firewall, endpoint services before load balancers, mirroring, VPN, transit gateways, IPAM cascaded, certificates; ready check for peering accepts and ACM

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---

### Task 7: Worker: lab files (migration 0025, callback, secret, clear) and lab-aws.yml step 16

Spec: §4 (`files`), §5 step 16, §6 (secret route, migration 0025), §10 (lab modal); rulings A13, A63, P2.

**Files:**
- Create: `worker/migrations/0025_lab_files.sql`, `worker/test/labs-aws-files.test.ts`
- Modify: `worker/src/labs/store.ts` (`LabRunDb.files_json`; `clearPasswords` → `clearSecrets`, which also nulls `files_json`), `worker/src/labs/settle.ts` (calls `clearSecrets`), `worker/src/labs/callbacks.ts` (`RESULT_KEYS` gains `files`; `readFiles`; the files stored on a succeeded deploy or test run of an `AWS_FILES_LABS` lab), `worker/src/api/labs.ts` (`GET /labs/:id/secret` returns `files`), `shared/api.ts` (`LabSecretResponse.files`), `.github/workflows/lab-aws.yml` (step 16 sends `files`), `worker/test/labs-helpers.ts` (`AWS_TEST_LABS` gains an `ans-31-client-vpn`), `worker/test/labs-read.test.ts` (the secret test's expected body gains `files: {}`), `scripts/test/lab-aws-workflow.test.mjs`
- Regenerate: `worker/src/demo/schema.gen.ts` (`npm run demo-schema`)

**Interfaces:**
- Produces: `LabSecretResponse = { adminPassword: string; users: Record<string, string>; files: Record<string, string> }` (Task 9 reads `files`); `export function readFiles(v: unknown): { ok: true; files: Record<string, string> } | { ok: false; why: string }` in `callbacks.ts`; `clearSecrets(env, sid)` in `store.ts` (the old name is removed; its two callers move).

**`worker/migrations/0025_lab_files.sql`**:
```sql
-- 0025_lab_files.sql
--
-- Plain English: a lab run's files (AWS labs ruling A13, plan ruling P2):
-- lab 31's Client VPN profile, client certificate and key, sent by the
-- workflow beside its result, handed out only by GET /labs/:id/secret while
-- the session runs, and cleared with the admin password when it ends.
ALTER TABLE lab_runs ADD COLUMN files_json TEXT;
```
**`worker/src/labs/callbacks.ts`**:
```ts
/** Ruling P2: the most a run may hand over, and the names it may use. */
export const FILES_MAX = 8;
export const FILE_BYTES_MAX = 16 * 1024;
export const FILES_BYTES_MAX = 48 * 1024;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A result's `files` (name -> text), or why they are refused. */
export function readFiles(v: unknown): { ok: true; files: Record<string, string> } | { ok: false; why: string } {
  if (v === undefined || v === null) return { ok: true, files: {} };
  if (!isObj(v)) return { ok: false, why: "files must be an object of name -> text" };
  const entries = Object.entries(v);
  if (entries.length > FILES_MAX) return { ok: false, why: `at most ${FILES_MAX} files` };
  let total = 0;
  for (const [name, text] of entries) {
    if (!FILE_NAME.test(name)) return { ok: false, why: `${name.slice(0, 40)} is not a file name this takes` };
    if (typeof text !== "string") return { ok: false, why: `${name} is not text` };
    const n = new TextEncoder().encode(text).length;
    if (n > FILE_BYTES_MAX) return { ok: false, why: `${name} is over ${FILE_BYTES_MAX / 1024} KiB` };
    total += n;
  }
  if (total > FILES_BYTES_MAX) return { ok: false, why: `the files are over ${FILES_BYTES_MAX / 1024} KiB together` };
  return { ok: true, files: Object.fromEntries(entries) as Record<string, string> };
}
```
and in `handleLabCallback`, after `readOutputs` and the run lookup:
```ts
  const files = readFiles(body.files);
  if (!files.ok) return badBody(files.why, "files");
  const hasFiles = Object.keys(files.files).length > 0;
  if (hasFiles && !(AWS_FILES_LABS.includes(run.lab_id) && (run.action === "deploy" || run.action === "test") && body.status === "success")) return badBody("files come only with a succeeded deploy or test of a lab that hands out files (ruling P2)", "files");
  if (hasFiles) await updateRun(env, run.id, { files_json: JSON.stringify(files.files) });
```
(before `finishRun`, so a session ended by that run's own result clears them at once). **`worker/src/labs/store.ts`**:
```ts
/** Forget every admin password and file of a session's runs (the session has ended: they open nothing now; A13). */
export async function clearSecrets(env: Env, sid: string): Promise<void> {
  await env.DB.prepare("UPDATE lab_runs SET admin_password = NULL, files_json = NULL WHERE session_id = ?1 AND (admin_password IS NOT NULL OR files_json IS NOT NULL)").bind(sid).run();
}
```
**`worker/src/api/labs.ts`**, the secret route: the query selects `admin_password, files_json` from the latest succeeded `deploy` **or `test`** run of the running session, and
```ts
    let files: Record<string, string> = {};
    try {
      files = JSON.parse(deploy.files_json ?? "{}") as Record<string, string>;
    } catch {
      files = {};
    }
    const out: LabSecretResponse = { adminPassword: deploy.admin_password, users, files };
```
**`.github/workflows/lab-aws.yml`**, step 16 (its comment: "A lab's files output (AWS_FILES_LABS, ruling P2) goes to the Worker in the body's own files key, never in LAB_RESULT or outputs"):
```bash
          files="{}"
          if [ "$status" = success ] && { [ "$action" = deploy ] || [ "$action" = test ]; } && [ -f "$RUNNER_TEMP/outputs.json" ]; then
            files="$(jq -c '.files.value // {}' "$RUNNER_TEMP/outputs.json")"
          fi
```
and the body gains `--argjson files "$files"` and `files:$files` beside `outputs`. `LAB_RESULT` is unchanged (`del(.files)` stays).

- [ ] **Step 1: Write the failing tests.** `worker/test/labs-aws-files.test.ts`:
```ts
// worker/test/labs-aws-files.test.ts
//
// Plain English: lab 31's files (plan ruling P2): stored on the run, handed
// out only by the secret route while the session runs, cleared at its end,
// and refused for any other lab, run or size.
import { describe, expect, it } from "vitest";
import { handleLabCallback, readFiles, FILES_MAX } from "../src/labs/callbacks";
import { api, deployLab, freeze, labDispatches, labEnv, rows, secrets, withAwsLabs } from "./labs-helpers";

const FILES = { "ans-31.ovpn": "client\ndev tun\n<ca>\n-----BEGIN CERTIFICATE-----\n</ca>\n", "client.crt": "-----BEGIN CERTIFICATE-----\nx\n", "client.key": "-----BEGIN PRIVATE KEY-----\ny\n" };
const OUT = { private_ips: { "vm-target": "10.64.0.10" }, connect: [], clean: null, leftovers: [], deploy_seconds: 300, destroy_seconds: null };

describe("lab files (ruling P2)", () => {
  it("Review Focus 5 / P2: files are stored on the run, returned only by secret while running, and cleared at session end", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const r = await deployLab(env, "ans-31-client-vpn");
    const s = await secrets(env, world, r.json.runId);
    expect((await handleLabCallback(env, s.callback_token, { run_id: r.json.runId, action: "deploy", status: "success", outputs: OUT, files: FILES })).status).toBe(200);
    const got = await api(env, "GET", "/labs/ans-31-client-vpn/secret");
    expect(got.json.files).toEqual(FILES);
    expect(got.headers.get("Cache-Control")).toBe("no-store");
    const session = await api(env, "GET", "/labs/ans-31-client-vpn");
    expect(JSON.stringify(session.json)).not.toContain("BEGIN PRIVATE KEY");
    expect(await rows(env, "SELECT outputs_json FROM lab_sessions")).not.toContainEqual(expect.objectContaining({ outputs_json: expect.stringContaining("client.key") }));
    await api(env, "POST", "/labs/ans-31-client-vpn/destroy", { confirm: true });
    const d = labDispatches(world).at(-1)!.payload.run_id as string;
    const ds = await secrets(env, world, d);
    await handleLabCallback(env, ds.callback_token, { run_id: d, action: "destroy", status: "success", outputs: { ...OUT, clean: true } });
    expect(await rows(env, "SELECT id FROM lab_runs WHERE files_json IS NOT NULL")).toEqual([]);
    expect((await api(env, "GET", "/labs/ans-31-client-vpn/secret")).status).toBe(409);
  });

  it("P2: files for another lab, a destroy, a failed deploy, too many or too large are refused", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const r = await deployLab(env, "soa-03-auto-scaling");
    const s = await secrets(env, world, r.json.runId);
    const res = await handleLabCallback(env, s.callback_token, { run_id: r.json.runId, action: "deploy", status: "success", outputs: OUT, files: { "a.txt": "x" } });
    expect(res.status).toBe(400);
    expect((res.body as { error: { field: string } }).error.field).toBe("files");
    expect(readFiles(Object.fromEntries(Array.from({ length: FILES_MAX + 1 }, (_, i) => [`f${i}.txt`, "x"]))).ok).toBe(false);
    expect(readFiles({ "big.txt": "x".repeat(17 * 1024) }).ok).toBe(false);
    expect(readFiles({ "../etc/passwd": "x" }).ok).toBe(false);
    expect(readFiles({ "ok.txt": 5 }).ok).toBe(false);
    expect(readFiles(undefined)).toEqual({ ok: true, files: {} });
  });
});
```
`worker/test/labs-read.test.ts`, "secret answers only while running": `toEqual({ adminPassword: s.admin_password, users: {…} })` gains `files: {}`. `worker/test/labs-helpers.ts`: `AWS_TEST_LABS` gains `base("ans-31-client-vpn", 31, { title: "AWS Client VPN with certificates, compared with WireGuard", exam: "ANS-C01", … })` in the shape of its `soa-03-auto-scaling` entry. `worker/test/demo-schema.test.ts` is unchanged (it fails until Step 3 regenerates).

`scripts/test/lab-aws-workflow.test.mjs`:
```js
test("ruling P2: step 16 sends files only beside the result, for a succeeded deploy or test, never in LAB_RESULT or outputs", () => {
  const report = stepNamed("Finish live log, Report result");
  assert.match(report.run, /files="\$\(jq -c '\.files\.value \/\/ \{\}' "\$RUNNER_TEMP\/outputs\.json"\)"/);
  assert.match(report.run, /\[ "\$status" = success \] && \{ \[ "\$action" = deploy \] \|\| \[ "\$action" = test \]; \}/);
  assert.match(report.run, /--argjson files "\$files"/);
  assert.match(report.run, /outputs:\{private_ips[^}]*\},\s*files:\$files|files:\$files/);
  assert.match(report.run, /echo "LAB_RESULT \$result"/);
  assert.doesNotMatch(report.run.split('echo "LAB_RESULT')[0].split("result=")[1] ?? "", /files/, "LAB_RESULT never carries files");
});
```
(`stepNamed` is the file's existing step reader.)

- [ ] **Step 2: Run them to make sure they fail**
Run: `npx vitest run worker/test/labs-aws-files.test.ts worker/test/labs-read.test.ts worker/test/labs-callbacks.test.ts` and `node --test scripts/test/lab-aws-workflow.test.mjs`
Expected: FAIL (`files` is "not something this takes"; no `readFiles`; the secret has no `files`; step 16 sends none).

- [ ] **Step 3: Write the migration and the changes** above; `npm run demo-schema`; `npx vitest run worker/test/demo-schema.test.ts` (PASS); `npm run migrate -- --local` for the dev database.

- [ ] **Step 4: Run the targeted tests**
Run: the Step 2 commands, `npx vitest run worker/test/demo-schema.test.ts worker/test/demo-facades.test.ts`, then `npm run typecheck`
Expected: PASS ("the admin password is cleared when the session ends" passes through `clearSecrets` unchanged).

- [ ] **Step 5: Commit**
```bash
git add worker/migrations/0025_lab_files.sql worker/src/demo/schema.gen.ts worker/src/labs/store.ts worker/src/labs/settle.ts worker/src/labs/callbacks.ts worker/src/api/labs.ts shared/api.ts .github/workflows/lab-aws.yml worker/test/labs-aws-files.test.ts worker/test/labs-read.test.ts worker/test/labs-helpers.ts scripts/test/lab-aws-workflow.test.mjs
git commit -m "feat(aws labs): lab files: step 16 sends them beside the result, the Worker keeps them on the run (migration 0025), Show hands them out, session end clears them

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---

### Task 8: Worker: us-west-2 reads, WAF and Lattice ARNs, a four-region diagram's budget

Spec: §6 (resources from tags; topology call cap), §10; rulings P22, P24.

**Files:**
- Modify: `worker/src/labs/awsReads.ts` (`arnParts`: `wafv2` and Lattice listeners), `worker/src/labs/resources.ts` (us-west-2 for `readsUsWest2`; group labels), `worker/src/labs/awsTopology.ts` (us-west-2 tagging call; `AWS_TOPOLOGY_CALLS_MAX` 15 → 16)
- Test: `worker/test/labs-aws-reads.test.ts`, `worker/test/topology-aws.test.ts`, `worker/test/labs-helpers.ts` (`AWS_TEST_LABS` gains an `ans-26-edge` with `regions.secondary = "eu-west-1"`)

**Interfaces:**
- Consumes: Task 1's `readsUsWest2`. Produces: `arnParts("arn:aws:wafv2:us-east-1:<a>:global/webacl/<n>/<id>")` = `{ service: "wafv2", type: "global/webacl", id: "<n>/<id>" }`; a Lattice listener ARN's `type` is `"listener"` (Task 10 maps both).

**`worker/src/labs/awsReads.ts`**, `arnParts`, after the API Gateway branch:
```ts
  // Ruling P22: a WAF ACL's scope and kind are its type (global/webacl, regional/webacl); a Lattice listener is a
  // listener, not its service.
  if (service === "wafv2") {
    const seg = resource.split("/");
    return { service, type: seg.slice(0, 2).join("/"), id: seg.slice(2).join("/") };
  }
  if (service === "vpc-lattice" && /^service\/[^/]+\/listener\//.test(resource)) return { service, type: "listener", id: resource.slice("service/".length) };
```
**`worker/src/labs/resources.ts`**: the regions become `[AWS_LAB_REGIONS[0], ...(def.regions.secondary ? [def.regions.secondary] : []), ...(readsUsEast1(def.id) ? ["us-east-1"] : []), ...(readsUsWest2(def.id) ? ["us-west-2"] : [])]` and the group label comes from
```ts
/** Ruling P24: what a lab keeps in each global region, for the resources panel's group label. */
function globalLabel(id: string, region: string): string {
  if (region === "us-west-2") return "Global Accelerator";
  if (AWS_GA_LABS.includes(id)) return "CloudFront, WAF";
  return AWS_GLOBAL_LABS.includes(id) ? "CloudFront, Route 53" : "Route 53";
}
```
(`group = region.startsWith("us-") ? \`${labResourceGroupName(def.id)} (global: ${globalLabel(def.id, region)})\` : …`). **`worker/src/labs/awsTopology.ts`**: `export const AWS_TOPOLOGY_CALLS_MAX = 16;` ("10 in the lab's region, 4 in its secondary, 1 in us-east-1 and 1 in us-west-2: lab 26 has all four, ruling P24"), and after the us-east-1 block:
```ts
  // Ruling P24: Global Accelerator's items are tagged in us-west-2; they sit in the lab's own container.
  if (readsUsWest2(labId)) {
    const tw = await labTagged(env, net, "us-west-2", labId);
    rows.push(...joinRows(tw, [], region));
    truncated = truncated || tw.truncated;
  }
```

- [ ] **Step 1: Write the failing tests.** `worker/test/labs-aws-reads.test.ts`:
```ts
  it("ruling P22: a WAF ACL and a Lattice listener name their own types", () => {
    expect(arnParts("arn:aws:wafv2:us-east-1:123456789012:global/webacl/lab-ans-26-edge-waf/0a1b")).toEqual({ service: "wafv2", type: "global/webacl", id: "lab-ans-26-edge-waf/0a1b" });
    expect(arnParts("arn:aws:vpc-lattice:eu-west-2:123456789012:service/svc-0a/listener/listener-0b")).toEqual({ service: "vpc-lattice", type: "listener", id: "svc-0a/listener/listener-0b" });
    expect(arnParts("arn:aws:vpc-lattice:eu-west-2:123456789012:service/svc-0a")).toEqual({ service: "vpc-lattice", type: "service", id: "svc-0a" });
    expect(arnParts("arn:aws:globalaccelerator::123456789012:accelerator/0abc")).toEqual({ service: "globalaccelerator", type: "accelerator", id: "0abc" });
  });

  it("ruling P24: lab 26's resources come from London, Ireland, us-east-1 and us-west-2, each labelled", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "ans-26-edge");
    const tag = (Name: string) => ({ "cloudlabs-lab": "ans-26-edge", Name });
    world.labAws.tagged["eu-west-2"] = [{ arn: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0ldn", tags: tag("vm-london") }];
    world.labAws.tagged["eu-west-1"] = [{ arn: "arn:aws:ec2:eu-west-1:123456789012:instance/i-0dub", tags: tag("vm-ireland") }];
    world.labAws.tagged["us-east-1"] = [{ arn: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/lab-ans-26-edge-waf/0a1b", tags: tag("waf-lab") }];
    world.labAws.tagged["us-west-2"] = [{ arn: "arn:aws:globalaccelerator::123456789012:accelerator/0abc", tags: tag("ga-lab") }];
    const r = await api(env, "GET", "/labs/ans-26-edge");
    expect(r.json.resources).toEqual([
      { name: "vm-london", type: "ec2:instance", group: "lab-ans-26-edge (London)", state: null },
      { name: "vm-ireland", type: "ec2:instance", group: "lab-ans-26-edge (Ireland)", state: null },
      { name: "waf-lab", type: "wafv2:global/webacl", group: "lab-ans-26-edge (global: CloudFront, WAF)", state: null },
      { name: "ga-lab", type: "globalaccelerator:accelerator", group: "lab-ans-26-edge (global: Global Accelerator)", state: null },
    ]);
  });
```
`worker/test/topology-aws.test.ts`, beside batch 3's P5 test:
```ts
  it("ruling P24: a four-region lab's live graph reads us-west-2 once, within the call cap", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    resetTopologyCache();
    await runningLab(env, world, "ans-26-edge");
    const seen = fakeAws();
    const r = await api(env, "GET", "/labs/ans-26-edge/topology");
    expect(r.json.status).toBe("ok");
    expect(AWS_TOPOLOGY_CALLS_MAX).toBe(16);
    expect(seen.length).toBeLessThanOrEqual(AWS_TOPOLOGY_CALLS_MAX);
    expect(seen.filter((s) => s.host.endsWith(".us-west-2.amazonaws.com")).map((s) => s.action)).toEqual(["ResourceGroupsTaggingAPI_20170126.GetResources"]);
  });
```
(The lab 09 test keeps asserting no us-west-2 call.)

- [ ] **Step 2: Run them to make sure they fail**
Run: `npx vitest run worker/test/labs-aws-reads.test.ts worker/test/topology-aws.test.ts`
Expected: FAIL (`type: "global"` for WAF; no us-west-2 read; the cap is 15).

- [ ] **Step 3: Write the changes** above.

- [ ] **Step 4: Run the targeted tests**
Run: `npx vitest run worker/test/labs-aws-reads.test.ts worker/test/topology-aws.test.ts worker/test/labs-aws-engine.test.ts && npm run typecheck`
Expected: PASS (batch 3's lab 09 and lab 16 tests unchanged).

- [ ] **Step 5: Commit**
```bash
git add worker/src/labs/awsReads.ts worker/src/labs/resources.ts worker/src/labs/awsTopology.ts worker/test/labs-aws-reads.test.ts worker/test/topology-aws.test.ts worker/test/labs-helpers.ts
git commit -m "feat(aws labs): the Worker reads Global Accelerator in us-west-2, names WAF ACLs and Lattice listeners, and fits a four-region diagram in 16 calls

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---

### Task 9: Web: lab files under Show with Download buttons

Spec: §10 (lab modal: "lab 31's files behind Show (files with a Download button each)"); rulings A13, P2, P25.

**Files:**
- Modify: `web/src/views/labs/RunningLab.tsx` (`Secret` lists `shown.files` under the sign-in values, one row each with a Download button), `web/src/views/labs/labs.css` (`.labs-files` rows, house tokens only)
- Test: `web/src/views/labs/running.test.tsx`

**Interfaces:**
- Consumes: Task 7's `LabSecretResponse.files`.

**`RunningLab.tsx`**, inside `Secret` (its comment gains "and lab 31's files, each downloadable (ruling P25)"):
```tsx
/** Save one file the lab handed over: a Blob, its own name, the object URL let go at once (ruling P25). */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```
and after the `KeyValue`:
```tsx
      {shown && Object.keys(shown.files ?? {}).length > 0 && (
        <ul className="labs-files" aria-label="Lab files">
          {Object.entries(shown.files).map(([name, text]) => (
            <li key={name} className="labs-files__row">
              <span className="labs-files__name">{name}</span>
              <Button size="sm" variant="secondary" onClick={() => download(name, text)} aria-label={`Download ${name}`}>
                Download
              </Button>
            </li>
          ))}
        </ul>
      )}
```
The muted line when hidden reads "The admin password, the lab's user names and its files, shown only when you ask." for an AWS lab with files (`aws` and `labFiles` props from the lab's `cloud` and `AWS_FILES_LABS.includes(labId)`), otherwise as now.

- [ ] **Step 1: Write the failing test** in `web/src/views/labs/running.test.tsx` (beside the existing secret test; same `open`, `detailRunning`, `PATH` helpers, with an AWS lab detail):
```tsx
  it("Review Focus 5 / P25: Show lists each file with a Download button; Hide forgets them", async () => {
    const secret = { adminPassword: "Fake-Pa55word-x", users: {}, files: { "ans-31.ovpn": "client\n", "client.key": "-----BEGIN PRIVATE KEY-----\n" } };
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => { created.push("blob:1"); return "blob:1"; });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => { revoked.push(u); });
    const { user } = open(detailRunning({ id: "ans-31-client-vpn", cloud: "aws" }), { [`GET /api/v1/labs/ans-31-client-vpn/secret`]: secret });
    await user.click(await screen.findByRole("button", { name: "Show" }));
    const list = await screen.findByRole("list", { name: "Lab files" });
    expect(within(list).getAllByRole("listitem").map((li) => li.querySelector(".labs-files__name")!.textContent)).toEqual(["ans-31.ovpn", "client.key"]);
    await user.click(within(list).getByRole("button", { name: "Download client.key" }));
    expect(created).toEqual(["blob:1"]);
    expect(revoked).toEqual(["blob:1"]);
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("list", { name: "Lab files" })).toBeNull();
    expect(document.body.textContent).not.toContain("BEGIN PRIVATE KEY");
  });

  it("a lab without files shows no file list", async () => {
    const { user } = open(detailRunning(), { [`GET ${PATH}/secret`]: { adminPassword: "Fake-Pa55word-x", users: {}, files: {} } });
    await user.click(await screen.findByRole("button", { name: "Show" }));
    await screen.findByText("Fake-Pa55word-x");
    expect(screen.queryByRole("list", { name: "Lab files" })).toBeNull();
  });
```
(`detailRunning(over)` takes overrides; give it that parameter if it has none. The existing secret test's mock gains `files: {}`.)

- [ ] **Step 2: Run it to make sure it fails**
Run: `npx vitest run web/src/views/labs/running.test.tsx`
Expected: FAIL (no "Lab files" list).

- [ ] **Step 3: Write the component and the styles** above (`.labs-files` a plain list with the section's spacing tokens; `.labs-files__name` mono, ellipsis on overflow).

- [ ] **Step 4: Run the targeted tests and the size check**
Run: `npx vitest run web/src/views/labs && npm run typecheck && npm run build:web && npm run bundle-size`
Expected: PASS; the bundle-size check passes unchanged (no dependency added).

- [ ] **Step 5: Commit**
```bash
git add web/src/views/labs/RunningLab.tsx web/src/views/labs/labs.css web/src/views/labs/running.test.tsx
git commit -m "feat(aws labs): lab files under Show, each with a Download button

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---

### Task 10: Topology: batch 4's types on the planned and live diagrams

Spec: §10 (topology kinds, the region lane); rulings A35, A77, P22.

**Files:**
- Modify: `shared/topology/rules/awsPlanned.ts` (batch 4's Terraform types), `shared/topology/kinds.ts` (`vpnGateway` gains nothing new; `internetGateway` gains `ec2:egress-only-internet-gateway` / `aws_egress_only_internet_gateway`; `wafPolicy`'s types stay `wafv2:global/webacl`, now matched; `lattice` gains `vpc-lattice:servicenetwork`'s Terraform type `aws_vpclattice_service_network`; `firewallPolicy` gains the rule groups' Terraform type folded), `shared/topology/awsLive.ts` (`AWS_LIVE_SKIP` gains batch 4's parts)
- Test: `worker/test/topology-aws.test.ts`

**Interfaces:**
- Produces: the kinds and keys Tasks 11–22's planned graphs and readme diagrams use: `ec2:transit-gateway` (`transitGateway`), `ec2:vpn-gateway`, `ec2:vpn-connection` (`vpnGateway`), `ec2:customer-gateway` (`localNetworkGateway`), `ec2:client-vpn-endpoint` (`clientVpn`), `vpc-lattice:service`, `vpc-lattice:servicenetwork` (`lattice`), `network-firewall:firewall` (`firewall`), `network-firewall:firewall-policy` (`firewallPolicy`), `globalaccelerator:accelerator` (`trafficManager`), `wafv2:global/webacl` (`wafPolicy`), `route53resolver:resolver-endpoint` (`dnsResolver`), `route53resolver:resolver-rule` (`dnsRuleset`), `ec2:vpc-endpoint-service` (`privateLinkService`), `ec2:egress-only-internet-gateway` (`internetGateway`); `generic` for `ec2:ipam`, `ec2:prefix-list`, `ec2:traffic-mirror-target`, `ec2:traffic-mirror-filter`, `acm:certificate`, `route53resolver:firewall-rule-group`, `route53resolver:resolver-query-log-config`.

**`shared/topology/rules/awsPlanned.ts`**, before the Systems Manager block:
```ts
  // ── Batch 4 (labs 20–31; ruling P22) ──
  aws_vpc_ipam: { arm: "ec2:ipam" },
  aws_vpc_ipam_pool: into("ipam_scope_id"),
  aws_vpc_ipam_pool_cidr: into("ipam_pool_id"),
  ...each(["aws_vpc_ipv6_cidr_block_association", "aws_vpc_ipv4_cidr_block_association"], into("vpc_id")),
  aws_egress_only_internet_gateway: { arm: "ec2:egress-only-internet-gateway" },
  aws_ec2_managed_prefix_list: { arm: "ec2:prefix-list" },
  aws_ec2_transit_gateway_peering_attachment: {
    fold: ["transit_gateway_id"],
    edges: (i, h) => {
      const a = h.refs(i, ["transit_gateway_id"])[0];
      const b = h.refs(i, ["peer_transit_gateway_id"])[0];
      return a && b ? [{ from: a, to: b, kind: "peering" as const, label: "inter-region peering" }] : [];
    },
  },
  ...each(["aws_ec2_transit_gateway_route_table", "aws_ec2_transit_gateway_route_table_association", "aws_ec2_transit_gateway_route_table_propagation", "aws_ec2_transit_gateway_route", "aws_ec2_transit_gateway_peering_attachment_accepter"], intoAny(["transit_gateway_id", "transit_gateway_route_table_id", "transit_gateway_attachment_id"])),
  aws_vpn_gateway: { arm: "ec2:vpn-gateway" },
  aws_customer_gateway: { arm: "ec2:customer-gateway" },
  aws_vpn_connection: {
    arm: "ec2:vpn-connection",
    edges: (i, h) => {
      const vgw = h.refs(i, ["vpn_gateway_id"])[0];
      const cgw = h.refs(i, ["customer_gateway_id"])[0];
      return vgw && cgw ? [{ from: vgw, to: cgw, kind: "traffic" as const, label: "IPsec, BGP" }] : [];
    },
  },
  aws_vpn_gateway_route_propagation: into("vpn_gateway_id"),
  aws_route53_resolver_endpoint: { arm: "route53resolver:resolver-endpoint", props: (i) => ({ sku: str(i.after.direction) }) },
  aws_route53_resolver_rule: {
    arm: "route53resolver:resolver-rule",
    edges: (i, h) => h.refs(i, ["resolver_endpoint_id"]).map((e) => ({ from: e, to: i, kind: "dependency" as const, label: "forwards" })),
  },
  ...each(["aws_route53_resolver_rule_association"], into("resolver_rule_id")),
  aws_route53_resolver_firewall_rule_group: { arm: "route53resolver:firewall-rule-group" },
  ...each(["aws_route53_resolver_firewall_rule", "aws_route53_resolver_firewall_rule_group_association"], into("firewall_rule_group_id")),
  // A domain list names no group (it has no firewall_rule_group_id): it folds into the rule that uses it, which folds into its group.
  aws_route53_resolver_firewall_domain_list: intoReferrer("aws_route53_resolver_firewall_rule"),
  aws_route53_resolver_query_log_config: { arm: "route53resolver:resolver-query-log-config" },
  aws_route53_resolver_query_log_config_association: into("resolver_query_log_config_id"),
  aws_vpc_endpoint_service: {
    arm: "ec2:vpc-endpoint-service",
    edges: (i, h) => h.refs(i, ["network_load_balancer_arns", "gateway_load_balancer_arns"]).map((lb) => ({ from: i, to: lb, kind: "dependency" as const, label: "fronts" })),
  },
  aws_acm_certificate: { arm: "acm:certificate" },
  aws_globalaccelerator_accelerator: { arm: "globalaccelerator:accelerator" },
  aws_globalaccelerator_listener: into("accelerator_arn"),
  aws_globalaccelerator_endpoint_group: {
    fold: ["listener_arn"],
    edges: (i, h) => {
      const ga = h.refs(i, ["listener_arn"]).flatMap((l) => h.refs(l, ["accelerator_arn"]))[0];
      return ga ? h.refs(i, ["endpoint_configuration"]).filter((t) => t.type === "aws_lb").map((lb) => ({ from: ga, to: lb, kind: "traffic" as const, label: str(i.after.endpoint_group_region) ?? "endpoint" })) : [];
    },
  },
  aws_cloudfront_function: intoReferrer("aws_cloudfront_distribution"),
  aws_wafv2_web_acl: { arm: "wafv2:global/webacl", edges: (i, h) => h.referrers(i, ["aws_cloudfront_distribution"], ["web_acl_id"]).map((d) => ({ from: i, to: d, kind: "dependency" as const, label: "protects" })) },
  aws_networkfirewall_firewall: { arm: "network-firewall:firewall" },
  aws_networkfirewall_firewall_policy: { arm: "network-firewall:firewall-policy", edges: (i, h) => h.referrers(i, ["aws_networkfirewall_firewall"], ["firewall_policy_arn"]).map((f) => ({ from: i, to: f, kind: "dependency" as const, label: "policy" })) },
  ...each(["aws_networkfirewall_rule_group"], intoReferrer("aws_networkfirewall_firewall_policy")),
  aws_networkfirewall_logging_configuration: into("firewall_arn"),
  aws_ec2_traffic_mirror_target: { arm: "ec2:traffic-mirror-target", edges: (i, h) => h.refs(i, ["network_interface_id"]).map((vm) => ({ from: i, to: vm, kind: "dependency" as const, label: "mirror to" })) },
  aws_ec2_traffic_mirror_filter: { arm: "ec2:traffic-mirror-filter" },
  aws_ec2_traffic_mirror_filter_rule: into("traffic_mirror_filter_id"),
  aws_glue_catalog_table: into("database_name"),
  aws_vpc_peering_connection_accepter: into("vpc_peering_connection_id"),
  aws_vpclattice_service_network: { arm: "vpc-lattice:servicenetwork" },
  aws_vpclattice_service: { arm: "vpc-lattice:service" },
  aws_vpclattice_service_network_service_association: {
    fold: ["service_identifier"],
    edges: (i, h) => {
      const sn = h.refs(i, ["service_network_identifier"])[0];
      const s = h.refs(i, ["service_identifier"])[0];
      return sn && s ? [{ from: sn, to: s, kind: "dependency" as const, label: "service" }] : [];
    },
  },
  aws_vpclattice_service_network_vpc_association: {
    fold: ["service_network_identifier"],
    edges: (i, h) => {
      const sn = h.refs(i, ["service_network_identifier"])[0];
      const vpc = h.refs(i, ["vpc_identifier"])[0];
      return sn && vpc ? [{ from: vpc, to: sn, kind: "traffic" as const, label: "associated" }] : [];
    },
  },
  aws_vpclattice_target_group: {
    fold: ["config"],
    edges: (i, h) => {
      const svc = h.referrers(i, ["aws_vpclattice_listener"], ["default_action"]).flatMap((l) => h.refs(l, ["service_identifier"]))[0];
      return svc ? h.referrers(i, ["aws_vpclattice_target_group_attachment"], ["target_group_identifier"]).flatMap((a) => h.refs(a, ["target"])).map((vm) => ({ from: svc, to: vm, kind: "traffic" as const, label: "HTTP" })) : [];
    },
  },
  ...each(["aws_vpclattice_target_group_attachment", "aws_vpclattice_listener", "aws_vpclattice_auth_policy"], intoAny(["target_group_identifier", "service_identifier", "resource_identifier"])),
  ...each(["aws_ec2_client_vpn_network_association", "aws_ec2_client_vpn_authorization_rule"], into("client_vpn_endpoint_id")),
```
(`into`, `intoReferrer`, `each` and `str` are the file's existing helpers, and `h.refs(inst, attrs)` and `h.referrers(inst, types[], attrs[])` its `PlannedHelpers` lookups; `intoAny(attrs)` folds into the first of `attrs` that refers to something drawn and is added beside `into`: `const intoAny = (attrs: string[]): TfRule => ({ fold: attrs });` (`fold` already takes the first that resolves). `TfRule` has no `parent`: cards are placed by their kind's placement and their references, as `aws_internet_gateway`'s and `aws_nat_gateway`'s are. Batch 1 already has `aws_ec2_transit_gateway`, `aws_ec2_transit_gateway_vpc_attachment` (its `attachment` edge), `aws_ec2_client_vpn_endpoint`, `aws_eip_association` and `aws_lb_listener_rule`, which stay as they are (an object literal may not repeat a key). The ignore list at the top (`tls_private_key`, `tls_self_signed_cert`, `tls_cert_request`, `archive_file`, `random_password`) gains `tls_locally_signed_cert` (batch 4 signs with it; the VPN test below pins no `tls` card).)

**`shared/topology/kinds.ts`** (the AWS map): `internetGateway: { icon: "internet-gateway", types: ["ec2:internet-gateway", "ec2:egress-only-internet-gateway"], tf: ["aws_internet_gateway", "aws_egress_only_internet_gateway"] }`; `lattice`'s `tf` stays `["aws_vpclattice_*"]` and its `types` gain nothing; every other batch 4 kind is already mapped (P22).
**`shared/topology/awsLive.ts`**: `AWS_LIVE_SKIP` gains `"ec2:transit-gateway-route-table"`, `"ec2:ipam-pool"`, `"ec2:ipam-scope"`, `"vpc-lattice:listener"`, `"vpc-lattice:targetgroup"`, `"vpc-lattice:servicenetworkvpcassociation"`, `"vpc-lattice:servicenetworkserviceassociation"`, `"route53resolver:firewall-rule-group-association"`, `"route53resolver:firewall-domain-list"`, `"network-firewall:stateful-rulegroup"`, `"network-firewall:stateless-rulegroup"`, `"ec2:traffic-mirror-filter-rule"` (each goes with what the plan draws).

- [ ] **Step 1: Write the failing tests** in `worker/test/topology-aws.test.ts` (batch 3's `b3`, `kindOf`, `edge` helpers, renamed `b4` for these labs):
```ts
describe("batch 4's types on the diagrams", () => {
  const b4 = (labId: string, changes: ReturnType<typeof ch>[], refs: Record<string, Record<string, string[]>>) => plannedGraph({ labId, version: 1, number: labId.slice(4, 6), changes: [ch("aws_resourcegroups_group.lab", { name: `lab-${labId}` }), ...changes], outputs: {}, refs } as never);
  const kindOf = (g: { nodes: { key: string; kind: string }[] }, k: string) => g.nodes.find((n) => n.key === k)?.kind;
  const edge = (g: { nodes: { key: string; id: string }[]; edges: { from: string; to: string; label?: string }[] }, a: string, b: string, label: string) => {
    const nid = (k: string) => g.nodes.find((n) => n.key === k)?.id;
    return g.edges.some((e) => e.from === nid(a) && e.to === nid(b) && e.label === label);
  };

  it("a transit gateway draws an edge per attachment; its route tables, associations and routes fold in; a peering joins two TGWs", () => {
    const g = b4("ans-29-multi-region", [
      ch("aws_vpc.lab", { tags: { Name: "vpc-lab" } }),
      ch("aws_ec2_transit_gateway.london", { tags: { Name: "tgw-london" } }),
      ch("aws_ec2_transit_gateway.ireland", { tags: { Name: "tgw-ireland" } }),
      ch("aws_ec2_transit_gateway_vpc_attachment.london", { tags: { Name: "tgwa-london" } }),
      ch("aws_ec2_transit_gateway_peering_attachment.li", { tags: { Name: "tgwp-london-ireland" } }),
      ch("aws_ec2_transit_gateway_route.l2i", { destination_cidr_block: "10.64.16.0/20" }),
    ], {
      "aws_ec2_transit_gateway_vpc_attachment.london": { transit_gateway_id: ["aws_ec2_transit_gateway.london"], vpc_id: ["aws_vpc.lab"] },
      "aws_ec2_transit_gateway_peering_attachment.li": { transit_gateway_id: ["aws_ec2_transit_gateway.london"], peer_transit_gateway_id: ["aws_ec2_transit_gateway.ireland"] },
      "aws_ec2_transit_gateway_route.l2i": { transit_gateway_attachment_id: ["aws_ec2_transit_gateway_peering_attachment.li"] },
    });
    expect(kindOf(g, "ec2:transit-gateway/tgw-london")).toBe("transitGateway");
    expect(edge(g, "ec2:transit-gateway/tgw-london", "ec2:vpc/vpc-lab", "attachment")).toBe(true);
    expect(edge(g, "ec2:transit-gateway/tgw-london", "ec2:transit-gateway/tgw-ireland", "inter-region peering")).toBe(true);
    expect(g.nodes.some((n) => /attachment|route/.test(n.key))).toBe(false);
  });

  it("DNS Firewall: a domain list folds into the rule that uses it, and the rule into its group", () => {
    const g = b4("ans-23-hybrid-dns", [
      ch("aws_route53_resolver_firewall_rule_group.lab", { name: "lab-ans-23-hybrid-dns-dnsfw", tags: { Name: "dnsfw-lab" } }),
      ch("aws_route53_resolver_firewall_domain_list.blocked", { name: "lab-ans-23-hybrid-dns-blocked", tags: { Name: "dnsfw-blocked" } }),
      ch("aws_route53_resolver_firewall_rule.block", { name: "block" }),
    ], { "aws_route53_resolver_firewall_rule.block": { firewall_rule_group_id: ["aws_route53_resolver_firewall_rule_group.lab"], firewall_domain_list_id: ["aws_route53_resolver_firewall_domain_list.blocked"] } });
    expect(kindOf(g, "route53resolver:firewall-rule-group/dnsfw-lab")).toBe("generic");
    expect(g.nodes.some((n) => /domain-list|dnsfw-blocked|firewall-rule\//.test(n.key))).toBe(false);
  });

  it("VPN: the gateway and customer gateway joined by the connection; Client VPN and Resolver kinds; certificates hidden", () => {
    const g = b4("ans-22-s2s-vpn", [
      ch("aws_vpn_gateway.lab", { tags: { Name: "vgw-lab" } }),
      ch("aws_customer_gateway.onprem", { tags: { Name: "cgw-onprem" } }),
      ch("aws_vpn_connection.lab", { tags: { Name: "vpn-lab" } }),
      ch("aws_ec2_client_vpn_endpoint.lab", { tags: { Name: "cvpn-lab" } }),
      ch("aws_route53_resolver_endpoint.in", { direction: "INBOUND", tags: { Name: "rslvr-in" } }),
      ch("tls_private_key.ca", {}),
      ch("aws_acm_certificate.server", { tags: { Name: "cert-cvpn-server" } }),
    ], { "aws_vpn_connection.lab": { vpn_gateway_id: ["aws_vpn_gateway.lab"], customer_gateway_id: ["aws_customer_gateway.onprem"] } });
    expect([kindOf(g, "ec2:vpn-gateway/vgw-lab"), kindOf(g, "ec2:customer-gateway/cgw-onprem"), kindOf(g, "ec2:client-vpn-endpoint/cvpn-lab"), kindOf(g, "route53resolver:resolver-endpoint/rslvr-in"), kindOf(g, "acm:certificate/cert-cvpn-server")]).toEqual(["vpnGateway", "localNetworkGateway", "clientVpn", "dnsResolver", "generic"]);
    expect(edge(g, "ec2:vpn-gateway/vgw-lab", "ec2:customer-gateway/cgw-onprem", "IPsec, BGP")).toBe(true);
    expect(g.nodes.some((n) => n.key.startsWith("tls"))).toBe(false);
  });

  it("the edge: the accelerator's endpoint groups draw edges to their NLBs; the ACL protects the distribution; Lattice joins VPC, network and services", () => {
    const g = b4("ans-26-edge", [
      ch("aws_lb.london", { load_balancer_type: "network", tags: { Name: "nlb-ldn" } }),
      ch("aws_globalaccelerator_accelerator.lab", { tags: { Name: "ga-lab" } }),
      ch("aws_globalaccelerator_listener.http", {}),
      ch("aws_globalaccelerator_endpoint_group.ldn", { endpoint_group_region: "eu-west-2" }),
      ch("aws_cloudfront_distribution.lab", { tags: { Name: "cdn-lab" } }),
      ch("aws_wafv2_web_acl.lab", { tags: { Name: "waf-lab" } }),
    ], {
      "aws_globalaccelerator_listener.http": { accelerator_arn: ["aws_globalaccelerator_accelerator.lab"] },
      "aws_globalaccelerator_endpoint_group.ldn": { listener_arn: ["aws_globalaccelerator_listener.http"], endpoint_configuration: ["aws_lb.london"] },
      "aws_cloudfront_distribution.lab": { web_acl_id: ["aws_wafv2_web_acl.lab"] },
    });
    expect([kindOf(g, "globalaccelerator:accelerator/ga-lab"), kindOf(g, "wafv2:global/webacl/waf-lab")]).toEqual(["trafficManager", "wafPolicy"]);
    expect(edge(g, "globalaccelerator:accelerator/ga-lab", "elasticloadbalancing:loadbalancer/nlb-ldn", "eu-west-2")).toBe(true);
    expect(edge(g, "wafv2:global/webacl/waf-lab", "cloudfront:distribution/cdn-lab", "protects")).toBe(true);
  });

  it("ruling P22: live, Lattice listeners, target groups and associations and TGW route tables are left out; WAF's ARN is a wafPolicy", () => {
    const row = (type: string, id: string, region = "eu-west-2", tags: Record<string, string> = {}): AwsRow => ({ arn: `arn:aws:${type.split(":")[0]}:${region}:123456789012:${type.split(":")[1]}/${id}`, type, id, region, name: tags.Name ?? null, tags: { "cloudlabs-lab": "ans-30-vpc-lattice", ...tags }, props: {}, refs: {} });
    const g = awsLiveGraph([
      row("resource-groups:group", "lab-ans-30-vpc-lattice", "eu-west-2", { Name: "lab-ans-30-vpc-lattice" }),
      row("vpc-lattice:service", "svc-0a", "eu-west-2", { Name: "svc-a" }),
      row("vpc-lattice:listener", "svc-0a/listener/l-1"),
      row("vpc-lattice:targetgroup", "tg-1"),
      row("vpc-lattice:servicenetworkvpcassociation", "snva-1"),
      row("ec2:transit-gateway-route-table", "tgw-rtb-1"),
    ], { labId: "ans-30-vpc-lattice", version: 1, gatewayVpcIds: [], at: "2026-10-17T00:00:00Z", region: "eu-west-2", secondaryRegion: null });
    const keys = g.nodes.map((n) => n.key);
    expect(keys.filter((k) => /listener|targetgroup|association|transit-gateway-route-table/.test(k))).toEqual([]);
    expect(kindOfAws("wafv2:global/webacl")).toBe("wafPolicy");
    expect(kindOfAws("ec2:egress-only-internet-gateway")).toBe("internetGateway");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**
Run: `npx vitest run worker/test/topology-aws.test.ts`
Expected: FAIL (batch 4's types are generic Terraform-only cards; no attachment, IPsec, endpoint-group or protects edges; listeners drawn live; DNS Firewall domain lists and rules drawn as cards).

- [ ] **Step 3: Write the rules, kinds and live skips** above.

- [ ] **Step 4: Run the targeted tests**
Run: `npx vitest run worker/test/topology-aws.test.ts worker/test/topology-golden.test.ts && npm run typecheck`
Expected: PASS (batches 1–3's golden diagrams unchanged).

- [ ] **Step 5: Commit**
```bash
git add shared/topology/rules/awsPlanned.ts shared/topology/kinds.ts shared/topology/awsLive.ts worker/test/topology-aws.test.ts
git commit -m "feat(aws labs): batch 4's types on the planned and live diagrams

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---

---

### Task 11: Lab ans-20-vpc-design

Spec: §12.2 row 20 (design, implementation; associate; explore; £ 0.05; peering optional; 5/5; 2/4; no prerequisites; dual-stack VPC, secondary CIDR, IPAM free tier, prefix lists, NAT gateway, egress-only internet gateway); §4 (addresses, NAT only where taught, IPv6 Amazon-provided only); §7.3 rules 10 and 11; design sheet "Lab 20"; rulings A11, A45, A82, P5, P6.

**Files:**
- Create: `labs/ans-20-vpc-design/lab.yaml`, `readme.md`
- Create: `labs/ans-20-vpc-design/terraform/versions.tf`, `main.tf`, `network.tf` (all three copied unchanged from `labs/_template-aws/`), `variables.tf` (the template's header and its `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags` blocks, unchanged), `ipam.tf`, `dual.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/ans-20-vpc-design.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-20-vpc-design.mjs`
- Create (generated): `shared/topology/planned/ans-20-vpc-design.json`, `shared/guides/ans-20-vpc-design/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`, `shared/guides/{index,placement}.json` (generated)
- Test: `scripts/test/labs-aws-ans-20.test.mjs`

**Interfaces:**
- Consumes: the template network (`aws_vpc.lab`, `aws_route_table.private`, `aws_security_group.eice`, `local.vpc_cidr`, `local.azs`, `local.cloud_init_base`); Task 2 (the IPAM, pool, provision and association rows, the egress-only gateway and prefix list creates, `ipam` made ahead); Task 3 (the IPAM, association, egress-only gateway and prefix list types; `fromInternet` for `::/0`); Task 4 (`batch4Problems`' lab 20 cases: Free Tier, one operating region, cascade, the Amazon-provided pool, netmask-only provisioning, the association on the lab's own pool, the slot-only secondary CIDR, the IPv4 prefix list inside the slot or the gateway's range; rule 10's `egress_only_gateway_id` by reference); Task 6 (IPAM cascaded last, `deleting` counted clean); Task 10 (`ec2:ipam` and `ec2:prefix-list` as `generic`, the egress-only gateway as `internetGateway`).
- Produces nothing other tasks call. Lab 21 and lab 22 name it as their prerequisite.

**`labs/ans-20-vpc-design/lab.yaml`**
```yaml
# Lab ans-20 (AWS labs batch 4). ANS-C01 ((V) the wording against the current
# exam guide): Network Design (IPv4 and IPv6 addressing, IPAM, egress
# choices); Network Implementation (dual-stack subnets, route tables,
# prefix lists).
# London list prices × 0.75 (labs-verify --aws-prices); the NAT gateway and
# its address bill each started hour whole (V, A20). IPAM's Free Tier, an
# Amazon-provided IPv6 pool, the egress-only gateway and the prefix list
# cost nothing (ruling P5; V on the IPAM pricing page, Task 23).
id: ans-20-vpc-design
version: 1
cloud: aws
title: "VPC design: dual stack, IPAM, prefix lists, egress"
summary: >-
  One VPC made dual stack: a secondary IPv4 range from the slot, IPv6 from a Free Tier IPAM pool of Amazon-provided
  space, a NAT gateway for IPv4 and an egress-only gateway for IPv6, and a managed prefix list that a security group
  names in place of addresses.
exam: ANS-C01
skill_areas: [ans.design, ans.implementation]
level: associate
type: explore
prerequisites: []
cost:
  items:
    - name: "NAT gateway, hourly"
      gbp_h: 0.0375
      whole_hours: true
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { productFamily: "NAT Gateway", usagetype: "{usage}-NatGateway-Hours" } }
    - name: "Public IPv4 address (the NAT gateway's)"
      gbp_h: 0.0038
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - name: "EC2 t4g.nano, Linux"
      gbp_h: 0.0035
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "IPAM Free Tier, an Amazon-provided IPv6 pool", gbp_h: 0 }
    - { name: "Egress-only internet gateway and prefix list", gbp_h: 0 }
    - { name: "EC2 Instance Connect Endpoint", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 4 }
capacity: { instance_types: [t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 2 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/ans-20-vpc-design/terraform/ipam.tf`**
```hcl
# ipam.tf
#
# Plain English: lab 20's IP Address Manager, on the Free Tier (ruling P5).
# One IPAM operating only in the session's region and, in its public scope,
# one pool, pool-v6: IPv6 space Amazon provides (never addresses the lab
# brings), advertisable for EC2 and VPCs in London. A /52 is provisioned to
# the pool (room for sixteen /56 VPC ranges) and vpc-lab takes one /56 from
# it (ruling A82: the association is judged on the lab's own tagged pool).
# Private IPv4 pools need the paid Advanced Tier, so the lab's second IPv4
# range (dual.tf) comes straight from the slot. cascade = true: deleting the
# IPAM takes its scopes and pools with it.

resource "aws_vpc_ipam" "lab" {
  description = "lab ${var.lab_id}: Free Tier IPAM in the session region"
  tier        = "free"
  cascade     = true

  operating_regions {
    region_name = var.region
  }
  tags = { Name = "ipam-lab" }
}

resource "aws_vpc_ipam_pool" "v6" {
  description      = "lab ${var.lab_id}: Amazon-provided IPv6 for VPCs in the session region"
  address_family   = "ipv6"
  ipam_scope_id    = aws_vpc_ipam.lab.public_default_scope_id
  locale           = var.region
  public_ip_source = "amazon"
  aws_service      = "ec2"
  tags             = { Name = "pool-v6" }
}

# Amazon-provided space: a netmask length only, never a literal range (BYOIP is never, ruling P5).
resource "aws_vpc_ipam_pool_cidr" "v6" {
  ipam_pool_id   = aws_vpc_ipam_pool.v6.id
  netmask_length = 52
}

resource "aws_vpc_ipv6_cidr_block_association" "lab" {
  vpc_id              = aws_vpc.lab.id
  ipv6_ipam_pool_id   = aws_vpc_ipam_pool.v6.id
  ipv6_netmask_length = 56
  depends_on          = [aws_vpc_ipam_pool_cidr.v6]
}
```

**`labs/ans-20-vpc-design/terraform/dual.tf`**
```hcl
# dual.tf
#
# Plain English: lab 20's dual-stack half of vpc-lab. A secondary IPv4 range
# (the slot's second /20, added to the VPC without IPAM) holds three subnets,
# each with a /64 of the VPC's IPv6 /56: snet-dual-1 and snet-dual-2 for
# instances, and snet-public for the NAT gateway. The ways out differ by
# family: rt-public sends both families to the internet gateway igw-lab;
# rt-dual sends IPv4 to the NAT gateway nat-lab (ruling A11: vm-dual reaches
# packages that way; vpce-s3 stays on rt-private) and IPv6 to the
# egress-only gateway eigw-lab, which lets replies in but never a new
# connection. And the managed prefix list pl-admin (the VPN server's VPC and
# vpc-lab's primary range; ruling P6: IPv4 inside the slot or the gateway's
# range only), which compute.tf's security group names instead of addresses.
# The template's Instance Connect Endpoint gains SSH to the secondary range.

locals {
  secondary_cidr = cidrsubnet(var.address_space, 2, 1)
  vpc_ipv6_cidr  = aws_vpc_ipv6_cidr_block_association.lab.ipv6_cidr_block
}

resource "aws_vpc_ipv4_cidr_block_association" "secondary" {
  vpc_id     = aws_vpc.lab.id
  cidr_block = local.secondary_cidr
}

resource "aws_subnet" "dual" {
  count                           = 2
  vpc_id                          = aws_vpc.lab.id
  cidr_block                      = cidrsubnet(local.secondary_cidr, 4, count.index)
  ipv6_cidr_block                 = cidrsubnet(local.vpc_ipv6_cidr, 8, count.index)
  assign_ipv6_address_on_creation = true
  availability_zone               = local.azs[count.index]
  map_public_ip_on_launch         = false
  tags                            = { Name = "snet-dual-${count.index + 1}" }
  depends_on                      = [aws_vpc_ipv4_cidr_block_association.secondary]
}

resource "aws_subnet" "public" {
  vpc_id                          = aws_vpc.lab.id
  cidr_block                      = cidrsubnet(local.secondary_cidr, 4, 2)
  ipv6_cidr_block                 = cidrsubnet(local.vpc_ipv6_cidr, 8, 2)
  assign_ipv6_address_on_creation = true
  availability_zone               = local.azs[0]
  map_public_ip_on_launch         = false
  tags                            = { Name = "snet-public" }
  depends_on                      = [aws_vpc_ipv4_cidr_block_association.secondary]
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "igw-lab" }
}

resource "aws_egress_only_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "eigw-lab" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-public" }
}

resource "aws_route" "public_v4" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.lab.id
}

resource "aws_route" "public_v6" {
  route_table_id              = aws_route_table.public.id
  destination_ipv6_cidr_block = "::/0"
  gateway_id                  = aws_internet_gateway.lab.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat" }
}

resource "aws_nat_gateway" "lab" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  tags          = { Name = "nat-lab" }
  depends_on    = [aws_internet_gateway.lab, aws_route.public_v4]
}

resource "aws_route_table" "dual" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-dual" }
}

resource "aws_route" "dual_v4" {
  route_table_id         = aws_route_table.dual.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.lab.id
}

resource "aws_route" "dual_v6" {
  route_table_id              = aws_route_table.dual.id
  destination_ipv6_cidr_block = "::/0"
  egress_only_gateway_id      = aws_egress_only_internet_gateway.lab.id
}

resource "aws_route_table_association" "dual" {
  count          = 2
  subnet_id      = aws_subnet.dual[count.index].id
  route_table_id = aws_route_table.dual.id
}

resource "aws_ec2_managed_prefix_list" "admin" {
  name           = "lab-${var.lab_id}-admin"
  address_family = "IPv4"
  max_entries    = 4

  entry {
    cidr        = var.gateway_cidr
    description = "the WireGuard server VPC"
  }
  entry {
    cidr        = local.vpc_cidr
    description = "vpc-lab primary"
  }
  tags = { Name = "pl-admin" }
}

# The template's endpoint sits in snet-private-1 (the primary range); it reaches vm-dual in the secondary one.
resource "aws_vpc_security_group_egress_rule" "eice_ssh_secondary" {
  security_group_id = aws_security_group.eice.id
  cidr_ipv4         = local.secondary_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}
```

**`labs/ans-20-vpc-design/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 20's one instance, vm-dual (t4g.nano, Amazon Linux
# 2023), in snet-dual-1 with an IPv4 address from the secondary range and one
# IPv6 address from the IPAM pool's /56. It serves a page on port 80 on both
# families (python3 bound to ::). Its security group, sg-dual, admits SSH
# and HTTP from the prefix list pl-admin (the VPN server's VPC and vpc-lab's
# primary range; ruling A45 through the list) and SSH from the Instance
# Connect Endpoint; nothing from the internet in either family (ruling P6).

locals {
  dual_unit = join("\n", [
    "[Unit]",
    "Description=Lab 20 page on port 80, IPv4 and IPv6",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --bind :: --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  dual_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-dual: dual stack in ${var.lab_id}\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.dual_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_security_group" "dual" {
  name        = "lab-dual"
  description = "vm-dual: SSH and HTTP from the admin prefix list, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-dual" }
}

resource "aws_vpc_security_group_ingress_rule" "dual_ssh_admin" {
  security_group_id = aws_security_group.dual.id
  prefix_list_id    = aws_ec2_managed_prefix_list.admin.id
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "dual_http_admin" {
  security_group_id = aws_security_group.dual.id
  prefix_list_id    = aws_ec2_managed_prefix_list.admin.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "dual_ssh_eice" {
  security_group_id            = aws_security_group.dual.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "dual_all_v4" {
  security_group_id = aws_security_group.dual.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "dual_all_v6" {
  security_group_id = aws_security_group.dual.id
  cidr_ipv6         = "::/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "dual" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.dual[0].id
  ipv6_address_count     = 1
  vpc_security_group_ids = [aws_security_group.dual.id]
  user_data              = local.dual_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-dual" })
  tags        = { Name = "vm-dual" }
  depends_on  = [aws_route.dual_v4, aws_route.dual_v6, aws_route_table_association.dual]
}
```

**`labs/ans-20-vpc-design/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 20 is up: vm-dual's IPv4
# address, console SSH to it, its IPv6 address (from the IPAM pool), and,
# while peered, SSH and the page from your PC. Both vpc-lab route tables get
# the pipeline's route back to the VPN server: rt-private and rt-dual (the
# gateway's /16 is more specific than rt-dual's default route to nat-lab).

output "private_ips" {
  value = { "vm-dual" = aws_instance.dual.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.dual.id} --os-user labadmin --connection-type eice",
    "IPv6: ${aws_instance.dual.ipv6_addresses[0]}",
    "ssh labadmin@${aws_instance.dual.private_ip}",
    "curl http://${aws_instance.dual.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id, aws_route_table.dual.id]
}
```

**`labs/ans-20-vpc-design/readme.md`** (exactly):
````markdown
One VPC, designed the way ANS-C01 expects: more IPv4 room added to it after it was made, IPv6 handed out by AWS's IP Address Manager (IPAM) from space Amazon provides, a different way out to the internet for each address family, and a managed prefix list so that a security group names a list of ranges instead of the ranges themselves. Everything is listed in the lab's resource group, `lab-ans-20-vpc-design`, in AWS Resource Groups (London).
From the ANS-C01 outline: design IP addressing for IPv4 and IPv6, and choose and implement the right internet egress for each.

## What it deploys

- The VPC `vpc-lab` with its usual first range (the slot's first /20, subnets `snet-private-1/2`) and a **secondary IPv4 range**, the slot's second /20, holding three dual-stack subnets: `snet-dual-1/2` for instances and `snet-public` for the NAT gateway
- **IPAM** `ipam-lab` on the Free Tier, working in London only, with the pool `pool-v6` in its public scope: a /52 of Amazon-provided IPv6, of which `vpc-lab` takes a /56; each dual-stack subnet gets a /64 of that
- **Two ways out**: the internet gateway `igw-lab` (route table `rt-public`, both families) for the NAT gateway `nat-lab`; and route table `rt-dual` for the instances, sending IPv4 to `nat-lab` and IPv6 to the egress-only gateway `eigw-lab`, which lets replies in but never a new connection from outside
- The managed prefix list `pl-admin` (`lab-ans-20-vpc-design-admin`): the VPN server's VPC and `vpc-lab`'s first range
- The instance `vm-dual` (t4g.nano) in `snet-dual-1`, with an IPv4 address from the secondary range and an IPv6 address from the pool, serving a page on port 80 on both; its security group `sg-dual` admits SSH and HTTP from `pl-admin` and SSH from the Instance Connect Endpoint `eice-lab`

```text
lab-ans-20-vpc-design (London)
  ipam-lab (Free Tier) > pool-v6 (Amazon IPv6 /52) --/56--> vpc-lab
  vpc-lab: primary /20 (snet-private-1/2, eice-lab) + secondary /20 (snet-dual-1/2, snet-public)
  vm-dual (snet-dual-1) --IPv4--> rt-dual --> nat-lab (snet-public) --> igw-lab --> internet
  vm-dual (snet-dual-1) --IPv6--> rt-dual --> eigw-lab --> internet (replies only come back)
  sg-dual: SSH and HTTP from pl-admin (VPN server VPC, vpc-lab primary)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Connect to `vm-dual` (the first Connect line) and look at its addresses with `ip -4 addr` and `ip -6 addr`. Then go out both ways: `curl -4 -sI https://aws.amazon.com | head -1` leaves through `nat-lab`, `curl -6 -sI https://aws.amazon.com | head -1` through `eigw-lab`. Run `curl -4 -s https://checkip.amazonaws.com` too: the address it prints is the NAT gateway's Elastic IP, not anything of `vm-dual`'s.
- In the VPC console, open `vpc-lab`'s **CIDRs** tab: the primary and secondary IPv4 ranges and the IPv6 /56, whose pool is `pool-v6`. In the IPAM console (Pools, `pool-v6`, Allocations) find the same /56 allocated to `vpc-lab`, and the /52 the pool holds.
- The IPv6 address in the second Connect line is a global address, unlike `vm-dual`'s IPv4 one. From any machine with IPv6, `curl -6 -m 5 http://[<that address>]` times out: the egress-only gateway admits replies only, and `sg-dual` admits nothing from the internet either.
- Open `sg-dual`'s inbound rules: they name `pl-admin`, not addresses. In the VPC console's Managed prefix lists, open `pl-admin`, choose **Modify prefix list** and remove the `vpc-lab primary` entry; look at `sg-dual` again (its rules have not changed, but what they admit has). Put the entry back afterwards. A list's `max_entries` counts against every rule that uses it, which is why this one is 4.
- Compare the two ways out: the NAT gateway costs about 3.75p an hour plus its address and data; the egress-only gateway is free. Work out what a fleet that only ever talks IPv6 to the internet would save.

## Learn more

- [What is IPAM?](https://docs.aws.amazon.com/vpc/latest/ipam/what-it-is-ipam.html)
- [Add IPv6 support for your VPC](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-migrate-ipv6.html)
- [Add or remove a CIDR block from your VPC](https://docs.aws.amazon.com/vpc/latest/userguide/add-ipv4-cidr.html)
- [Enable outbound IPv6 traffic using an egress-only internet gateway](https://docs.aws.amazon.com/vpc/latest/userguide/egress-only-internet-gateway.html)
- [Group CIDR blocks using managed prefix lists](https://docs.aws.amazon.com/vpc/latest/userguide/managed-prefix-lists.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-20-vpc-design` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-20-vpc-design.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Give a VPC a second IPv4 range, IPv6 from an IPAM pool and the right way out for each family.
learn:
  - Add a secondary IPv4 range and IPv6 from an IPAM pool to a VPC
  - Send IPv4 out through a NAT gateway and IPv6 through an egress-only gateway
  - Name a managed prefix list in security group rules instead of addresses
learning_min: 45
```

**The diagram** must contain: `resourceGroup lab-ans-20-vpc-design · London`; `vnet vpc-lab` with `subnet snet-private-1`, `snet-private-2`, `snet-dual-1`, `snet-dual-2`, `snet-public`; `internetGateway igw-lab < vpc-lab` and `internetGateway eigw-lab < vpc-lab` (Task 10 maps the egress-only gateway to `internetGateway`); `natGateway nat-lab < snet-public` (its Elastic IP folded in); `routeTable rt-private`, `rt-public`, `rt-dual` (each `< vpc-lab`); `nsg sg-eice`, `sg-vms`, `sg-dual` (each `< vpc-lab`); `vm vm-dual < snet-dual-1`; `bastion eice-lab < snet-private-1`; `privateEndpoint vpce-s3 < vpc-lab`; `generic ipam-lab` and `generic pl-admin` (each `< lab-ans-20-vpc-design · London`; the pool, its CIDR and both CIDR associations fold in). Edges: `rt-dual ..> nat-lab : 0.0.0.0/0`, `rt-public ..> igw-lab : 0.0.0.0/0`, and `rt-public ..> igw-lab` (the `::/0` route has no IPv4 destination to label it; the egress-only route draws no edge, as `aws_route`'s rule only draws routes to internet and NAT gateways).

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-ans-20.test.mjs`:

```js
// labs-aws-ans-20.test.mjs
//
// Plain English: lab ans-20-vpc-design is the lab AWS labs spec §12.2 row 20
// describes, as ruling P5 builds it: one dual-stack VPC with a secondary
// IPv4 range from the slot, IPv6 from a Free Tier IPAM pool of
// Amazon-provided space, a NAT gateway for IPv4, an egress-only gateway for
// IPv6, and a managed prefix list a security group names (rulings P5, P6,
// A11, A45, A82).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-20-vpc-design";
const body = (blocks, type, name) => blocks.find((b) => b.kind === "resource" && b.labels[0] === type && b.labels[1] === name)?.body ?? "";
const count = (text, re) => [...text.matchAll(re)].length;

test("ans-20 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-20's lab.yaml: §12.2 row 20, about £0.05/h with the NAT gateway billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "associate", "explore", ["ans.design", "ans.implementation"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  assert.deepEqual([yaml.capacity, yaml.regions], [{ instance_types: ["t4g.nano"] }, { secondary: null }]);
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.04 && total < 0.055, `about £0.046/h, got ${total}`);
  assert.equal(yaml.cost.items.find((i) => i.name === "NAT gateway, hourly").whole_hours, true);
  for (const n of ["IPAM Free Tier, an Amazon-provided IPv6 pool", "Egress-only internet gateway and prefix list"]) assert.equal(yaml.cost.items.find((i) => i.name === n).gbp_h, 0, n);
});

test("ruling P5: a Free Tier IPAM in the session's region, an Amazon-provided IPv6 pool with a /52, a /56 for vpc-lab; never a literal range", () => {
  const { files, blocks } = awsLab(ID);
  const ipam = files["ipam.tf"];
  for (const re of [/tier\s+= "free"/, /cascade\s+= true/, /operating_regions \{\n\s+region_name = var\.region\n\s+\}/, /address_family\s+= "ipv6"/, /ipam_scope_id\s+= aws_vpc_ipam\.lab\.public_default_scope_id/, /locale\s+= var\.region/, /public_ip_source = "amazon"/, /aws_service\s+= "ec2"/, /netmask_length = 52/, /vpc_id\s+= aws_vpc\.lab\.id/, /ipv6_ipam_pool_id\s+= aws_vpc_ipam_pool\.v6\.id/, /ipv6_netmask_length = 56/, /depends_on\s+= \[aws_vpc_ipam_pool_cidr\.v6\]/]) assert.match(ipam, re);
  assert.doesNotMatch(body(blocks, "aws_vpc_ipam_pool_cidr", "v6"), /^\s*cidr\s*=/m, "a netmask length only: BYOIP is never");
  for (const t of ["aws_vpc_ipam", "aws_vpc_ipam_pool", "aws_vpc_ipam_pool_cidr", "aws_vpc_ipv6_cidr_block_association"]) assert.equal(blocks.filter((b) => b.kind === "resource" && b.labels[0] === t).length, 1, t);
});

test("ans-20's dual stack: the slot's second /20 as a secondary range, three subnets each with a /64, IPv4 out through NAT and IPv6 through the egress-only gateway", () => {
  const { files } = awsLab(ID);
  const dual = files["dual.tf"];
  for (const re of [/secondary_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/, /vpc_ipv6_cidr\s+= aws_vpc_ipv6_cidr_block_association\.lab\.ipv6_cidr_block/, /cidr_block\s+= local\.secondary_cidr/, /cidrsubnet\(local\.secondary_cidr, 4, count\.index\)/, /cidrsubnet\(local\.vpc_ipv6_cidr, 8, count\.index\)/, /cidrsubnet\(local\.secondary_cidr, 4, 2\)/, /cidrsubnet\(local\.vpc_ipv6_cidr, 8, 2\)/, /destination_ipv6_cidr_block = "::\/0"\n\s+egress_only_gateway_id\s+= aws_egress_only_internet_gateway\.lab\.id/, /destination_ipv6_cidr_block = "::\/0"\n\s+gateway_id\s+= aws_internet_gateway\.lab\.id/, /destination_cidr_block = "0\.0\.0\.0\/0"\n\s+nat_gateway_id\s+= aws_nat_gateway\.lab\.id/, /subnet_id\s+= aws_subnet\.public\.id/]) assert.match(dual, re);
  assert.equal(count(dual, /assign_ipv6_address_on_creation = true/g), 2, "both subnet blocks");
  assert.equal(count(dual, /depends_on\s+= \[aws_vpc_ipv4_cidr_block_association\.secondary\]/g), 2, "subnets wait for the secondary range");
  assert.equal(count(dual, /resource "aws_route"/g), 4);
  assert.equal(count(dual, /resource "aws_nat_gateway"/g), 1);
  assert.doesNotMatch(dual, /map_public_ip_on_launch\s+= true/);
  // Ruling A11: the S3 endpoint stays on rt-private only (network.tf is the template's, unchanged).
  assert.doesNotMatch(dual, /aws_vpc_endpoint"/);
});

test("ruling P6: the prefix list holds only the gateway's range and vpc-lab's; sg-dual names it and admits nothing from the internet", () => {
  const { files, blocks } = awsLab(ID);
  const pl = body(blocks, "aws_ec2_managed_prefix_list", "admin");
  for (const re of [/name\s+= "lab-\$\{var\.lab_id\}-admin"/, /address_family = "IPv4"/, /max_entries\s+= 4/, /cidr\s+= var\.gateway_cidr/, /cidr\s+= local\.vpc_cidr/]) assert.match(pl, re);
  assert.equal(count(pl, /entry \{/g), 2);
  const compute = files["compute.tf"];
  assert.equal(count(compute, /prefix_list_id\s+= aws_ec2_managed_prefix_list\.admin\.id/g), 2, "SSH and HTTP from the list");
  const ingress = blocks.filter((b) => b.kind === "resource" && b.labels[0] === "aws_vpc_security_group_ingress_rule" && b.labels[1].startsWith("dual_"));
  assert.equal(ingress.length, 3);
  for (const b of ingress) assert.doesNotMatch(b.body, /cidr_ipv[46]/, `${b.labels[1]} names no range`);
  for (const re of [/ipv6_address_count\s+= 1/, /subnet_id\s+= aws_subnet\.dual\[0\]\.id/, /--bind :: --directory \/srv\/www/, /instance_type\s+= "t4g\.nano"/]) assert.match(compute, re);
  assert.match(files["dual.tf"], /security_group_id = aws_security_group\.eice\.id\n\s+cidr_ipv4\s+= local\.secondary_cidr/, "eice-lab reaches the secondary range");
});

test("ans-20's outputs: vm-dual's IPv6 address, and both vpc-lab route tables get the route back when peered", () => {
  const { files } = awsLab(ID);
  assert.match(files["outputs.tf"], /"IPv6: \$\{aws_instance\.dual\.ipv6_addresses\[0\]\}"/);
  assert.match(files["outputs.tf"], /value = \[aws_route_table\.private\.id, aws_route_table\.dual\.id\]/);
});

test("ans-20's readme names each piece and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["ipam-lab", "pool-v6", "eigw-lab", "nat-lab", "pl-admin", "snet-dual-1/2", "checkip.amazonaws.com", "Modify prefix list"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-ans-20.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf` and `network.tf` from `labs/_template-aws/` unchanged; `variables.tf` is the template's file with only the seven variables named (each block exactly as the template writes it, as `commonAwsProblems` checks).

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/ans-20-vpc-design.mjs` (header comment in the house style, naming the files and what is known at plan): `const c = ctxAws("ans-20-vpc-design", "20")`, `const sec = cidrsubnet(c.address, 2, 1)`; `variables: c.variables`, `providers: ["aws"]`, `providerConfig: AWS_PROVIDER_CONFIG`, `data: awsData()`; `resources: [...templateResources(c), …]` with, in file order (every value below known at plan; `tagged(c, …)` on every type with `tags`; the IPv4 and IPv6 CIDR associations, the pool CIDR, routes, route table associations and security group rules carry no `tags` and so no `tags_all`, except the security group rules, which are tagged as the template's are):
  - `ipam.tf`: `aws_vpc_ipam.lab` { `description: "lab ans-20-vpc-design: Free Tier IPAM in the session region"`, `tier: "free"`, `cascade: true`, `operating_regions: [{ region_name: "eu-west-2" }]`, `tags: { Name: "ipam-lab" }` }, refs `description: ["var.lab_id"]`, `"operating_regions.0.region_name": ["var.region"]`; `aws_vpc_ipam_pool.v6` { `description` (the lab id spelled out), `address_family: "ipv6"`, `locale: "eu-west-2"`, `public_ip_source: "amazon"`, `aws_service: "ec2"`, `tags: { Name: "pool-v6" }` }, unknown `ipam_scope_id` (ref `aws_vpc_ipam.lab` `public_default_scope_id`), refs `description: ["var.lab_id"]`, `locale: ["var.region"]`; `aws_vpc_ipam_pool_cidr.v6` { `netmask_length: 52` }, unknown `ipam_pool_id` (ref the pool's `id`); `aws_vpc_ipv6_cidr_block_association.lab` { `ipv6_netmask_length: 56` }, unknown `vpc_id` (ref `aws_vpc.lab`), `ipv6_ipam_pool_id` (ref the pool).
  - `dual.tf`: `aws_vpc_ipv4_cidr_block_association.secondary` { `cidr_block: sec` }, unknown `vpc_id`, refs `cidr_block: ["local.secondary_cidr"]`; `aws_subnet.dual[0..1]` (`count: 2`) { `cidr_block: cidrsubnet(sec, 4, i)`, `assign_ipv6_address_on_creation: true`, `availability_zone: "eu-west-2a"/"eu-west-2b"`, `map_public_ip_on_launch: false`, `tags: { Name: "snet-dual-<i+1>" }` }, unknown `vpc_id`, `ipv6_cidr_block`, refs `vpc_id`, `cidr_block: ["local.secondary_cidr", "count.index"]`, `ipv6_cidr_block: ["local.vpc_ipv6_cidr", "count.index"]`, `availability_zone: ["local.azs", "count.index"]`, `tags: ["count.index"]`; `aws_subnet.public` (k = 2, `eu-west-2a`, `snet-public`, refs `["local.secondary_cidr"]`, `["local.vpc_ipv6_cidr"]`, `["local.azs"]`); `aws_internet_gateway.lab` (`igw-lab`) and `aws_egress_only_internet_gateway.lab` (`eigw-lab`), unknown `vpc_id`; `aws_route_table.public` (`rt-public`) and `.dual` (`rt-dual`); `aws_route.public_v4` { `destination_cidr_block: "0.0.0.0/0"` } and `.public_v6` { `destination_ipv6_cidr_block: "::/0"` }, unknown `route_table_id`, `gateway_id`; `aws_route_table_association.public`; `aws_eip.nat` { `domain: "vpc"`, `eip-nat` }; `aws_nat_gateway.lab` (`nat-lab`), unknown `allocation_id`, `subnet_id` (ref `aws_subnet.public`); `aws_route.dual_v4` (`nat_gateway_id` unknown) and `.dual_v6` { `destination_ipv6_cidr_block: "::/0"` } (`egress_only_gateway_id` unknown, ref `aws_egress_only_internet_gateway.lab`); `aws_route_table_association.dual[0..1]` (`count: 2`, refs `subnet_id: ["aws_subnet.dual", "count.index"]`); `aws_ec2_managed_prefix_list.admin` { `name: "lab-ans-20-vpc-design-admin"`, `address_family: "IPv4"`, `max_entries: 4`, `entry: [{ cidr: GATEWAY_CIDR, description: "the WireGuard server VPC" }, { cidr: c.vpcCidr, description: "vpc-lab primary" }]`, `tags: { Name: "pl-admin" }` }, refs `name: ["var.lab_id"]`, `"entry.0.cidr": ["var.gateway_cidr"]`, `"entry.1.cidr": ["local.vpc_cidr"]`; `aws_vpc_security_group_egress_rule.eice_ssh_secondary` { `cidr_ipv4: sec`, TCP 22 }, unknown `security_group_id` (ref `aws_security_group.eice`), refs `cidr_ipv4: ["local.secondary_cidr"]`.
  - `compute.tf`: `aws_security_group.dual` (`lab-dual`, its description, `sg-dual`); the three ingress rules (`dual_ssh_admin`, `dual_http_admin`: TCP 22, 80, unknown `security_group_id`, `prefix_list_id` (ref the list's `id`); `dual_ssh_eice`: unknown `referenced_security_group_id`, ref `aws_security_group.eice`); egress `dual_all_v4` (`0.0.0.0/0`, `-1`) and `dual_all_v6` (`cidr_ipv6: "::/0"`, `-1`); `al2023Instance(c, { key: "dual", name: "vm-dual", subnet: "aws_subnet.dual[0]", type: "t4g.nano", sgs: ["aws_security_group.dual"] })` with `values.ipv6_address_count = 1` and `refs.user_data = ["local.dual_cloud_init"]` (known at plan: built from `var.lab_id` and the session password; sensitive).

  `lab-plans.test.mjs` proves it, the scope check included (after Tasks 3 and 4).

- [ ] **Step 5: Generate the planned graph and the readme diagram** (`npm run labs-topology -- ans-20-vpc-design`, `npm run labs-diagrams -- ans-20-vpc-design`), check the graph against "The diagram" above, add `GOLDEN["ans-20-vpc-design"]` (the generated graph's nodes and edges as `kind label < parent` and `from ..> to : label` lines, every line above among them) to `worker/test/topology-golden.test.ts` and the id to `AWS_LAB_IDS` in `worker/test/fixtures/topology/round-trip.ts`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-20.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-20-vpc-design`, `npm run labs-topology -- --check ans-20-vpc-design`, `npm run labs-diagrams -- --check`
Expected: all PASS. (Drafted 2026-10-16: `terraform fmt -check`, `init -backend=false`, `validate` (aws 6.69.1) and `lab-lint --cloud aws` pass; the `labs-tf` mock plan applies cleanly and its scope check refuses only the seven batch 4 types Task 3 adds; this test file passes against the drafted folder.)

- [ ] **Step 7: Commit**

```bash
git add labs/ans-20-vpc-design labs/_learning/ans-20-vpc-design.yaml shared/topology/planned/ans-20-vpc-design.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-20 VPC design: dual stack, Free Tier IPAM IPv6 pool, prefix list, NAT and egress-only gateways

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 12: Lab ans-21-transit-gateway

Spec: §12.2 row 21 (design, implementation; expert; explore; ££ 0.17; peering optional; 8/8; 2/4; prerequisite 20; TGW, 3 VPCs (2 spokes, egress), segmented route tables, blackhole route, appliance mode, NAT in the egress VPC) and "Not built here" (Cloud WAN, RAM sharing: readme-only); §4 (NAT where taught); design sheet "Lab 21"; rulings A45, A57, P15.

**Files:**
- Create: `labs/ans-21-transit-gateway/lab.yaml`, `readme.md`
- Create: `labs/ans-21-transit-gateway/terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged), `variables.tf` (the template's header and seven variables: `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `spoke-b.tf`, `egress.tf`, `tgw.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/ans-21-transit-gateway.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-21-transit-gateway.mjs`
- Create (generated): `shared/topology/planned/ans-21-transit-gateway.json`, `shared/guides/ans-21-transit-gateway/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`, `shared/guides/{index,placement}.json` (generated)
- Test: `scripts/test/labs-aws-ans-21.test.mjs`

**Interfaces:**
- Consumes: the template network; Task 2 (transit gateway, attachment, route table creates; route, association and propagation changes); Task 3 (the transit gateway types); Task 4 (P15: attachments of the lab's own VPCs and subnets by reference, at most 4 per transit gateway, routes to the slot or `0.0.0.0/0` or blackhole, `auto_accept_shared_attachments` disabled; rule 10's `transit_gateway_id` by reference); Task 6 (attachments, route tables, then the transit gateway; `deleting` counted clean); Task 10 (`transitGateway`, attachment edges, route tables folded).
- Produces nothing other tasks call. Labs 27 and 29 name it as their prerequisite.

**`labs/ans-21-transit-gateway/lab.yaml`**
```yaml
# Lab ans-21 (AWS labs batch 4). ANS-C01 ((V) the wording against the current
# exam guide): Network Design (hub-and-spoke with a transit gateway,
# segmentation, centralised egress); Network Implementation (attachments,
# route table associations and propagations, appliance mode).
# London list prices × 0.75 (labs-verify --aws-prices); the transit gateway
# attachments, the NAT gateway and its address bill each started hour whole
# (V, A20; the attachment filter is V, Task 23). Transit Gateway data
# processing is per GB (authored, light test traffic).
id: ans-21-transit-gateway
version: 1
cloud: aws
title: "Transit Gateway: segmentation and central egress"
summary: >-
  A transit gateway joining three VPCs: two spokes that may not reach each other (separate route tables and a
  blackhole route) and an egress VPC whose one NAT gateway is every spoke's way to the internet.
exam: ANS-C01
skill_areas: [ans.design, ans.implementation]
level: expert
type: explore
prerequisites: [ans-20-vpc-design]
cost:
  items:
    - name: "Transit gateway VPC attachments (3), hourly"
      gbp_h: 0.0375
      qty: 3
      whole_hours: true
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { usagetype: "{usage}-TransitGateway-Hours" } }
    - name: "NAT gateway, hourly"
      gbp_h: 0.0375
      whole_hours: true
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { productFamily: "NAT Gateway", usagetype: "{usage}-NatGateway-Hours" } }
    - name: "Public IPv4 address (the NAT gateway's)"
      gbp_h: 0.0038
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - name: "EC2 t4g.nano, Linux (2 running)"
      gbp_h: 0.0035
      qty: 2
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 2
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "Transit Gateway data processing, light test traffic", gbp_h: 0.0005 }
    - { name: "EC2 Instance Connect Endpoints (2)", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 8, destroy_min: 8, session_h: 2, max_h: 4 }
capacity: { instance_types: [t4g.nano, t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 3 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/ans-21-transit-gateway/terraform/spoke-b.tf`**
```hcl
# spoke-b.tf
#
# Plain English: lab 21's second spoke, vpc-spoke-b (the slot's second
# /20), two private subnets in two zones, its own route table rt-spoke-b
# (its default route to the transit gateway is in tgw.tf), a free S3 gateway
# endpoint and its own Instance Connect Endpoint, eice-spoke-b, so vm-b is
# reachable from the console though no route leads to it from vpc-lab.

locals {
  spoke_b_cidr = cidrsubnet(var.address_space, 2, 1)
}

resource "aws_vpc" "spoke_b" {
  cidr_block           = local.spoke_b_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-spoke-b" }
}

resource "aws_subnet" "spoke_b" {
  count                   = 2
  vpc_id                  = aws_vpc.spoke_b.id
  cidr_block              = cidrsubnet(local.spoke_b_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-spoke-b-${count.index + 1}" }
}

resource "aws_route_table" "spoke_b" {
  vpc_id = aws_vpc.spoke_b.id
  tags   = { Name = "rt-spoke-b" }
}

resource "aws_route_table_association" "spoke_b" {
  count          = 2
  subnet_id      = aws_subnet.spoke_b[count.index].id
  route_table_id = aws_route_table.spoke_b.id
}

resource "aws_vpc_endpoint" "spoke_b_s3" {
  vpc_id            = aws_vpc.spoke_b.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.spoke_b.id]
  tags              = { Name = "vpce-s3-spoke-b" }
}

resource "aws_security_group" "eice_spoke_b" {
  name        = "lab-eice-spoke-b"
  description = "Instance Connect Endpoint in vpc-spoke-b: SSH out to vm-b"
  vpc_id      = aws_vpc.spoke_b.id
  tags        = { Name = "sg-eice-spoke-b" }
}

resource "aws_vpc_security_group_egress_rule" "eice_spoke_b_ssh" {
  security_group_id = aws_security_group.eice_spoke_b.id
  cidr_ipv4         = local.spoke_b_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "spoke_b" {
  subnet_id          = aws_subnet.spoke_b[0].id
  security_group_ids = [aws_security_group.eice_spoke_b.id]
  preserve_client_ip = false
  tags               = { Name = "eice-spoke-b" }
}
```

**`labs/ans-21-transit-gateway/terraform/egress.tf`**
```hcl
# egress.tf
#
# Plain English: lab 21's central way out, vpc-egress (the slot's third
# /20). The transit gateway's interfaces sit in snet-egress-tgw-1/2, whose
# route table rt-egress-tgw sends everything to the NAT gateway nat-egress;
# the NAT gateway sits in snet-egress-public, whose route table
# rt-egress-public sends the internet to igw-egress and the whole slot back
# to the transit gateway (that route is in tgw.tf), so replies find their
# spoke. No instance runs here: the spokes share this one NAT gateway.

locals {
  egress_cidr = cidrsubnet(var.address_space, 2, 2)
}

resource "aws_vpc" "egress" {
  cidr_block           = local.egress_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-egress" }
}

resource "aws_subnet" "egress_tgw" {
  count                   = 2
  vpc_id                  = aws_vpc.egress.id
  cidr_block              = cidrsubnet(local.egress_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-egress-tgw-${count.index + 1}" }
}

resource "aws_subnet" "egress_public" {
  vpc_id                  = aws_vpc.egress.id
  cidr_block              = cidrsubnet(local.egress_cidr, 4, 2)
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-egress-public" }
}

resource "aws_internet_gateway" "egress" {
  vpc_id = aws_vpc.egress.id
  tags   = { Name = "igw-egress" }
}

resource "aws_route_table" "egress_public" {
  vpc_id = aws_vpc.egress.id
  tags   = { Name = "rt-egress-public" }
}

resource "aws_route" "egress_public_internet" {
  route_table_id         = aws_route_table.egress_public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.egress.id
}

resource "aws_route_table_association" "egress_public" {
  subnet_id      = aws_subnet.egress_public.id
  route_table_id = aws_route_table.egress_public.id
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat" }
}

resource "aws_nat_gateway" "egress" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.egress_public.id
  tags          = { Name = "nat-egress" }
  depends_on    = [aws_internet_gateway.egress, aws_route.egress_public_internet]
}

resource "aws_route_table" "egress_tgw" {
  vpc_id = aws_vpc.egress.id
  tags   = { Name = "rt-egress-tgw" }
}

resource "aws_route" "egress_tgw_nat" {
  route_table_id         = aws_route_table.egress_tgw.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.egress.id
}

resource "aws_route_table_association" "egress_tgw" {
  count          = 2
  subnet_id      = aws_subnet.egress_tgw[count.index].id
  route_table_id = aws_route_table.egress_tgw.id
}
```

**`labs/ans-21-transit-gateway/terraform/tgw.tf`**
```hcl
# tgw.tf
#
# Plain English: lab 21's transit gateway, tgw-lab, and how it segments the
# three VPCs (ruling P15). Its default route table is off, so every
# attachment is associated and propagated by hand: spoke A (vpc-lab), spoke
# B and the egress VPC each attach in two zones, the egress attachment in
# appliance mode (a flow and its reply keep to one zone). The spokes use
# tgw-rt-spokes: everything to the egress VPC, and spoke B's range a
# blackhole, so spoke A can never reach spoke B. The egress attachment uses
# tgw-rt-egress, which both spokes propagate into, so replies from the
# internet find their way back. Each spoke's default route points at the
# transit gateway, and the egress VPC's public route table sends the slot
# back to it. Nothing is shared with another account
# (auto_accept_shared_attachments off).

resource "aws_ec2_transit_gateway" "lab" {
  description                     = "lab ${var.lab_id}: two spokes and central egress"
  amazon_side_asn                 = 64512
  auto_accept_shared_attachments  = "disable"
  default_route_table_association = "disable"
  default_route_table_propagation = "disable"
  dns_support                     = "enable"
  tags                            = { Name = "tgw-lab" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "spoke_a" {
  transit_gateway_id                              = aws_ec2_transit_gateway.lab.id
  vpc_id                                          = aws_vpc.lab.id
  subnet_ids                                      = aws_subnet.private[*].id
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false
  tags                                            = { Name = "tgwa-spoke-a" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "spoke_b" {
  transit_gateway_id                              = aws_ec2_transit_gateway.lab.id
  vpc_id                                          = aws_vpc.spoke_b.id
  subnet_ids                                      = aws_subnet.spoke_b[*].id
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false
  tags                                            = { Name = "tgwa-spoke-b" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "egress" {
  transit_gateway_id                              = aws_ec2_transit_gateway.lab.id
  vpc_id                                          = aws_vpc.egress.id
  subnet_ids                                      = aws_subnet.egress_tgw[*].id
  appliance_mode_support                          = "enable"
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false
  tags                                            = { Name = "tgwa-egress" }
}

resource "aws_ec2_transit_gateway_route_table" "spokes" {
  transit_gateway_id = aws_ec2_transit_gateway.lab.id
  tags               = { Name = "tgw-rt-spokes" }
}

resource "aws_ec2_transit_gateway_route_table" "egress" {
  transit_gateway_id = aws_ec2_transit_gateway.lab.id
  tags               = { Name = "tgw-rt-egress" }
}

resource "aws_ec2_transit_gateway_route_table_association" "spoke_a" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_a.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_ec2_transit_gateway_route_table_association" "spoke_b" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_b.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_ec2_transit_gateway_route_table_association" "egress" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.egress.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.egress.id
}

resource "aws_ec2_transit_gateway_route_table_propagation" "spoke_a" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_a.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.egress.id
}

resource "aws_ec2_transit_gateway_route_table_propagation" "spoke_b" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_b.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.egress.id
}

resource "aws_ec2_transit_gateway_route" "spokes_default" {
  destination_cidr_block         = "0.0.0.0/0"
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.egress.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_ec2_transit_gateway_route" "spokes_blackhole_b" {
  destination_cidr_block         = local.spoke_b_cidr
  blackhole                      = true
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

# A VPC route to a transit gateway needs that VPC's attachment first.
resource "aws_route" "spoke_a_default" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.spoke_a]
}

resource "aws_route" "spoke_b_default" {
  route_table_id         = aws_route_table.spoke_b.id
  destination_cidr_block = "0.0.0.0/0"
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.spoke_b]
}

resource "aws_route" "egress_public_slot" {
  route_table_id         = aws_route_table.egress_public.id
  destination_cidr_block = var.address_space
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.egress]
}
```

**`labs/ans-21-transit-gateway/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 21's two test instances, each serving a page naming
# itself: vm-a (t4g.nano) in spoke A, snet-private-1, and vm-b (t4g.nano) in
# spoke B, snet-spoke-b-1. Both admit ping (ICMP) and HTTP from anywhere in
# the lab's slot, so what stops one reaching the other is the transit
# gateway's route tables, never a security group. vm-a also keeps the
# template's sg-vms (SSH from eice-lab, the VPN server's range when peered);
# vm-b admits SSH from its own spoke's Instance Connect Endpoint.

locals {
  web_unit = {
    path        = "/etc/systemd/system/lab-web.service"
    permissions = "0644"
    content     = join("\n", ["[Unit]", "Description=Lab page on port 80", "After=network-online.target", "[Service]", "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www", "Restart=always", "[Install]", "WantedBy=multi-user.target", ""])
  }
  web_runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
}

resource "aws_security_group" "vms_a" {
  name        = "lab-vms-a"
  description = "vm-a: ping and HTTP from the lab slot"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-vms-a" }
}

resource "aws_vpc_security_group_ingress_rule" "vms_a_icmp" {
  security_group_id = aws_security_group.vms_a.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "vms_a_http" {
  security_group_id = aws_security_group.vms_a.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_security_group" "vms_b" {
  name        = "lab-vms-b"
  description = "vm-b: ping and HTTP from the lab slot, SSH from the spoke B Instance Connect Endpoint"
  vpc_id      = aws_vpc.spoke_b.id
  tags        = { Name = "sg-vms-b" }
}

resource "aws_vpc_security_group_ingress_rule" "vms_b_icmp" {
  security_group_id = aws_security_group.vms_b.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "vms_b_http" {
  security_group_id = aws_security_group.vms_b.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "vms_b_ssh_eice" {
  security_group_id            = aws_security_group.vms_b.id
  referenced_security_group_id = aws_security_group.eice_spoke_b.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "vms_b_all" {
  security_group_id = aws_security_group.vms_b.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "a" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.vms_a.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/srv/www/index.html", permissions = "0644", content = "vm-a in spoke A (vpc-lab)\n" }, local.web_unit]
    runcmd      = local.web_runcmd
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-a" })
  tags        = { Name = "vm-a" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "b" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.spoke_b[0].id
  vpc_security_group_ids = [aws_security_group.vms_b.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/srv/www/index.html", permissions = "0644", content = "vm-b in spoke B (vpc-spoke-b)\n" }, local.web_unit]
    runcmd      = local.web_runcmd
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-b" })
  tags        = { Name = "vm-b" }
  depends_on  = [aws_vpc_endpoint.spoke_b_s3]
}
```

**`labs/ans-21-transit-gateway/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 21 is up: both test
# instances' addresses and console SSH to each, and, while peered, SSH and
# the page on vm-a. Only spoke A (vpc-lab) is peered to the VPN server: the
# gateway's /16 in rt-private is more specific than the default route to
# the transit gateway, so that traffic still takes the peering.

output "private_ips" {
  value = { "vm-a" = aws_instance.a.private_ip, "vm-b" = aws_instance.b.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.a.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.b.id} --os-user labadmin --connection-type eice",
    "ssh labadmin@${aws_instance.a.private_ip}",
    "curl http://${aws_instance.a.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/ans-21-transit-gateway/readme.md`** (exactly):
````markdown
A transit gateway is a router you rent by the attachment: VPCs plug into it, and its route tables decide who may talk to whom. This lab plugs in three VPCs, two spokes and an egress VPC, and segments them: the spokes may not reach each other, but both reach the internet through the egress VPC's one NAT gateway. Everything is listed in the lab's resource group, `lab-ans-21-transit-gateway`, in AWS Resource Groups (London).
From the ANS-C01 outline: design and implement hub-and-spoke routing with AWS Transit Gateway, including segmentation and centralised internet egress.

## What it deploys

- Three VPCs, each a /20 of the slot: spoke A is `vpc-lab` (`snet-private-1/2`), spoke B is `vpc-spoke-b` (`snet-spoke-b-1/2`), and `vpc-egress` holds the transit gateway's subnets `snet-egress-tgw-1/2` and the public subnet `snet-egress-public` with the NAT gateway `nat-egress` and the internet gateway `igw-egress`
- The transit gateway `tgw-lab` with its default route table switched off and three attachments: `tgwa-spoke-a`, `tgwa-spoke-b` and `tgwa-egress` (in appliance mode, so a flow and its reply keep to one zone)
- Two transit gateway route tables: `tgw-rt-spokes` (both spokes are associated with it) sends `0.0.0.0/0` to the egress attachment and holds a **blackhole** route for spoke B's range; `tgw-rt-egress` (the egress attachment's) learns both spokes' ranges by propagation, so replies find their way back
- VPC routes: each spoke's default route points at `tgw-lab`; in the egress VPC, `rt-egress-tgw` sends everything to `nat-egress` and `rt-egress-public` sends the internet to `igw-egress` and the slot back to `tgw-lab`
- Two test instances serving a page naming themselves: `vm-a` (t4g.nano) in spoke A and `vm-b` (t4g.nano) in spoke B, each admitting ping and HTTP from the whole slot, so only the routing decides; Instance Connect Endpoints `eice-lab` and `eice-spoke-b`

```text
lab-ans-21-transit-gateway (London)
  vm-a (vpc-lab) ---> tgwa-spoke-a --+                      +--> tgwa-egress --> vpc-egress
  vm-b (vpc-spoke-b) -> tgwa-spoke-b -+-- tgw-rt-spokes ----+    rt-egress-tgw --> nat-egress --> igw-egress --> internet
                                      0.0.0.0/0 -> egress, spoke B /20 -> blackhole
  replies: igw-egress --> nat-egress --> rt-egress-public (slot -> tgw-lab) --> tgw-rt-egress (both spokes propagated)
  peering (optional, AWS server only, spoke A only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Connect to `vm-a` (the first Connect line) and run `curl -s https://checkip.amazonaws.com`: the address it prints is `nat-egress`'s Elastic IP. Do the same on `vm-b` (the second line): the same address, because both spokes share one NAT gateway.
- From `vm-a`, `ping -c 3` and `curl -m 5` `vm-b`'s address: nothing answers, though `vm-b`'s security group admits both. In the VPC console, open Transit gateway route tables, `tgw-rt-spokes`, **Routes**: spoke B's range is a blackhole. Look at the **Associations** and **Propagations** tabs of both tables too.
- Now try it the other way, from `vm-b` to `vm-a`. Spoke A's range is not blackholed, so the packets follow `0.0.0.0/0` to the egress VPC. Does `vm-a` answer? Work out from the four route tables (`tgw-rt-spokes`, `rt-egress-tgw`, `rt-egress-public`, `tgw-rt-egress`) where the packets go, then add a blackhole route for spoke A's range (`vpc-lab`'s /20) to `tgw-rt-spokes` in the console and try again. Remove it afterwards.
- Open `tgwa-egress` and find **Appliance mode support: enable**. Think about why it matters when a firewall in the egress VPC must see both directions of a flow (lab 27 builds exactly that).
- Count the cost: three attachments at about 3.75p an hour each plus 2p a GB processed, against VPC peering, which has no hourly charge but needs a peering for every pair of VPCs.

**Not built here** (each needs another account or a much larger budget): AWS Cloud WAN, a managed global network of transit-gateway-like segments with a policy document, and sharing a transit gateway with other accounts through AWS RAM. Both are in the Learn more links.

## Learn more

- [How transit gateways work](https://docs.aws.amazon.com/vpc/latest/tgw/how-transit-gateways-work.html)
- [Transit gateway route tables](https://docs.aws.amazon.com/vpc/latest/tgw/tgw-route-tables.html)
- [Centralized egress to the internet](https://docs.aws.amazon.com/whitepapers/latest/building-scalable-secure-multi-vpc-network-infrastructure/centralized-egress-to-internet.html)
- [Appliance in a shared services VPC (appliance mode)](https://docs.aws.amazon.com/vpc/latest/tgw/transit-gateway-appliance-scenario.html)
- [What is AWS Cloud WAN?](https://docs.aws.amazon.com/network-manager/latest/cloudwan/what-is-cloudwan.html)
- [Share a transit gateway with AWS RAM (in Work with AWS Transit Gateway)](https://docs.aws.amazon.com/vpc/latest/tgw/transit-gateway-share.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-21-transit-gateway` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-21-transit-gateway.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Join three VPCs through one transit gateway, keep two spokes apart and share one way out.
learn:
  - Associate and propagate attachments into separate transit gateway route tables
  - Isolate one spoke from another with a blackhole route
  - Send every spoke's internet traffic through one NAT gateway
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-ans-21-transit-gateway · London`; `vnet vpc-lab` (`subnet snet-private-1/2`), `vnet vpc-spoke-b` (`subnet snet-spoke-b-1/2`), `vnet vpc-egress` (`subnet snet-egress-tgw-1/2`, `snet-egress-public`); `transitGateway tgw-lab < lab-ans-21-transit-gateway · London` (its two route tables, three associations, two propagations and two routes fold in, P22); `internetGateway igw-egress < vpc-egress`; `natGateway nat-egress < snet-egress-public`; `routeTable rt-private`, `rt-spoke-b`, `rt-egress-tgw`, `rt-egress-public`; `nsg sg-eice`, `sg-vms`, `sg-vms-a` (`< vpc-lab`), `sg-eice-spoke-b`, `sg-vms-b` (`< vpc-spoke-b`); `vm vm-a < snet-private-1`, `vm vm-b < snet-spoke-b-1`; `bastion eice-lab < snet-private-1`, `bastion eice-spoke-b < snet-spoke-b-1`; `privateEndpoint vpce-s3 < vpc-lab`, `privateEndpoint vpce-s3-spoke-b < vpc-spoke-b`. Edges: `tgw-lab ..> vpc-lab : attachment`, `tgw-lab ..> vpc-spoke-b : attachment`, `tgw-lab ..> vpc-egress : attachment` (Task 10's attachment edge, kind `peering`, prints as `..>`), `rt-egress-public ..> igw-egress : 0.0.0.0/0`, `rt-egress-tgw ..> nat-egress : 0.0.0.0/0` (routes to the transit gateway draw no edge).

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-ans-21.test.mjs`:

```js
// labs-aws-ans-21.test.mjs
//
// Plain English: lab ans-21-transit-gateway is the lab AWS labs spec §12.2
// row 21 describes: a transit gateway with three VPC attachments (two
// spokes and an egress VPC), segmented route tables with a blackhole route,
// appliance mode on the egress attachment, and one NAT gateway in the
// egress VPC shared by both spokes (ruling P15).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-21-transit-gateway";
const of = (blocks, type) => blocks.filter((b) => b.kind === "resource" && b.labels[0] === type);
const body = (blocks, type, name) => of(blocks, type).find((b) => b.labels[1] === name)?.body ?? "";
const count = (text, re) => [...text.matchAll(re)].length;

test("ans-21 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-21's lab.yaml: §12.2 row 21, after lab 20, three /20s, about £0.16/h with the attachments and NAT billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.implementation"], ["ans-20-vpc-design"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 8, destroy_min: 8, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 3 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.15 && total < 0.18, `about £0.163/h, got ${total}`);
  const tgw = yaml.cost.items.find((i) => i.name === "Transit gateway VPC attachments (3), hourly");
  assert.deepEqual([tgw.qty, tgw.whole_hours, tgw.aws_price.filters.usagetype], [3, true, "{usage}-TransitGateway-Hours"]);
  assert.equal(yaml.cost.items.find((i) => i.name === "NAT gateway, hourly").whole_hours, true);
});

test("ruling P15: one transit gateway, its default table off, nothing shared, three attachments of the lab's own VPCs, appliance mode on the egress one only", () => {
  const { blocks, files } = awsLab(ID);
  const tgw = body(blocks, "aws_ec2_transit_gateway", "lab");
  for (const re of [/auto_accept_shared_attachments\s+= "disable"/, /default_route_table_association = "disable"/, /default_route_table_propagation = "disable"/, /amazon_side_asn\s+= 64512/]) assert.match(tgw, re);
  const att = of(blocks, "aws_ec2_transit_gateway_vpc_attachment");
  assert.deepEqual(att.map((b) => b.labels[1]).sort(), ["egress", "spoke_a", "spoke_b"]);
  for (const b of att) {
    assert.match(b.body, /transit_gateway_id\s+= aws_ec2_transit_gateway\.lab\.id/);
    assert.match(b.body, /transit_gateway_default_route_table_association = false/);
    assert.match(b.body, /transit_gateway_default_route_table_propagation = false/);
  }
  assert.match(body(blocks, "aws_ec2_transit_gateway_vpc_attachment", "egress"), /appliance_mode_support\s+= "enable"/);
  assert.equal(count(files["tgw.tf"], /appliance_mode_support/g), 1);
  assert.equal(of(blocks, "aws_ec2_transit_gateway").length, 1);
});

test("ans-21's segmentation: spokes to egress and spoke B blackholed in tgw-rt-spokes; both spokes propagated into tgw-rt-egress", () => {
  const { blocks } = awsLab(ID);
  const assoc = Object.fromEntries(of(blocks, "aws_ec2_transit_gateway_route_table_association").map((b) => [b.labels[1], b.body.match(/transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table\.(\w+)\.id/)[1]]));
  assert.deepEqual(assoc, { spoke_a: "spokes", spoke_b: "spokes", egress: "egress" });
  const prop = of(blocks, "aws_ec2_transit_gateway_route_table_propagation");
  assert.deepEqual(prop.map((b) => b.labels[1]).sort(), ["spoke_a", "spoke_b"]);
  for (const b of prop) assert.match(b.body, /transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table\.egress\.id/);
  const dflt = body(blocks, "aws_ec2_transit_gateway_route", "spokes_default");
  for (const re of [/destination_cidr_block\s+= "0\.0\.0\.0\/0"/, /transit_gateway_attachment_id\s+= aws_ec2_transit_gateway_vpc_attachment\.egress\.id/, /aws_ec2_transit_gateway_route_table\.spokes\.id/]) assert.match(dflt, re);
  const hole = body(blocks, "aws_ec2_transit_gateway_route", "spokes_blackhole_b");
  for (const re of [/destination_cidr_block\s+= local\.spoke_b_cidr/, /blackhole\s+= true/, /aws_ec2_transit_gateway_route_table\.spokes\.id/]) assert.match(hole, re);
  assert.doesNotMatch(hole, /transit_gateway_attachment_id/);
});

test("ans-21's VPCs and routes: spoke B and egress are the slot's second and third /20s; each VPC route to the transit gateway waits for its attachment; one NAT gateway", () => {
  const { blocks, files, tf } = awsLab(ID);
  assert.match(files["spoke-b.tf"], /spoke_b_cidr = cidrsubnet\(var\.address_space, 2, 1\)/);
  assert.match(files["egress.tf"], /egress_cidr = cidrsubnet\(var\.address_space, 2, 2\)/);
  assert.equal(count(tf, /resource "aws_nat_gateway"/g), 1);
  assert.match(body(blocks, "aws_nat_gateway", "egress"), /subnet_id\s+= aws_subnet\.egress_public\.id/);
  assert.match(body(blocks, "aws_route", "egress_tgw_nat"), /nat_gateway_id\s+= aws_nat_gateway\.egress\.id/);
  const toTgw = { spoke_a_default: "spoke_a", spoke_b_default: "spoke_b", egress_public_slot: "egress" };
  for (const [route, attachment] of Object.entries(toTgw)) {
    const b = body(blocks, "aws_route", route);
    assert.match(b, /transit_gateway_id\s+= aws_ec2_transit_gateway\.lab\.id/, route);
    assert.match(b, new RegExp(`depends_on\\s+= \\[aws_ec2_transit_gateway_vpc_attachment\\.${attachment}\\]`), route);
  }
  assert.match(body(blocks, "aws_route", "egress_public_slot"), /destination_cidr_block = var\.address_space/);
  for (const sg of ["vms_a", "vms_b"]) for (const proto of ["icmp", "tcp"]) assert.ok(of(blocks, "aws_vpc_security_group_ingress_rule").some((b) => b.body.includes(`aws_security_group.${sg}.id`) && /cidr_ipv4\s+= var\.address_space/.test(b.body) && b.body.includes(`"${proto}"`)), `${sg} ${proto}`);
});

test("ans-21's readme explains segmentation and central egress, names what is not built, and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["tgw-rt-spokes", "tgw-rt-egress", "blackhole", "nat-egress", "Appliance mode support", "Cloud WAN", "AWS RAM", "checkip.amazonaws.com"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-ans-21.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; trim `variables.tf` to the seven variables named.

- [ ] **Step 4: Write the plan fixture** `ans-21-transit-gateway.mjs`: `const c = ctxAws("ans-21-transit-gateway", "21")`, `const b = cidrsubnet(c.address, 2, 1)`, `const e = cidrsubnet(c.address, 2, 2)`; `data: awsData()`; `resources: [...templateResources(c), …]`:
  - `spoke-b.tf`: `aws_vpc.spoke_b` { `cidr_block: b`, DNS on, `vpc-spoke-b` } refs `["local.spoke_b_cidr"]`; `aws_subnet.spoke_b[0..1]` (`count: 2`, `cidrsubnet(b, 4, i)`, zones a and b, refs `["local.spoke_b_cidr", "count.index"]`, `["local.azs", "count.index"]`, tags `["count.index"]`); `aws_route_table.spoke_b`; `aws_route_table_association.spoke_b[0..1]` (refs `["aws_subnet.spoke_b", "count.index"]`); `aws_vpc_endpoint.spoke_b_s3` (`com.amazonaws.eu-west-2.s3`, Gateway, unknown `vpc_id`, `route_table_ids`); `aws_security_group.eice_spoke_b` (`lab-eice-spoke-b`), its egress rule (`cidr_ipv4: b`, TCP 22, refs `["local.spoke_b_cidr"]`); `aws_ec2_instance_connect_endpoint.spoke_b` (`preserve_client_ip: false`, unknown `subnet_id` with refs `["aws_subnet.spoke_b[0].id", "aws_subnet.spoke_b[0]", "aws_subnet.spoke_b"]` and `security_group_ids.0`).
  - `egress.tf`: `aws_vpc.egress` (`cidr_block: e`, `vpc-egress`, refs `["local.egress_cidr"]`); `aws_subnet.egress_tgw[0..1]` (`count: 2`, k = 0, 1); `aws_subnet.egress_public` (k = 2, zone a); `aws_internet_gateway.egress`; `aws_route_table.egress_public`; `aws_route.egress_public_internet` (`0.0.0.0/0`, unknown `route_table_id`, `gateway_id`); `aws_route_table_association.egress_public`; `aws_eip.nat` (`domain: "vpc"`); `aws_nat_gateway.egress` (unknown `allocation_id`, `subnet_id` ref `aws_subnet.egress_public`); `aws_route_table.egress_tgw`; `aws_route.egress_tgw_nat` (`0.0.0.0/0`, unknown `nat_gateway_id`); `aws_route_table_association.egress_tgw[0..1]`.
  - `tgw.tf`: `aws_ec2_transit_gateway.lab` { `description: "lab ans-21-transit-gateway: two spokes and central egress"`, `amazon_side_asn: 64512`, `auto_accept_shared_attachments: "disable"`, `default_route_table_association: "disable"`, `default_route_table_propagation: "disable"`, `dns_support: "enable"`, `tgw-lab` } refs `description: ["var.lab_id"]`; the three `aws_ec2_transit_gateway_vpc_attachment`s { `transit_gateway_default_route_table_association: false`, `…_propagation: false`, `appliance_mode_support: "enable"` on `egress` only, Name } unknown `transit_gateway_id`, `vpc_id`, `subnet_ids` with refs (`subnet_ids: ["aws_subnet.private"]` / `["aws_subnet.spoke_b"]` / `["aws_subnet.egress_tgw"]`, as a splat prints); the two `aws_ec2_transit_gateway_route_table`s (tagged, unknown `transit_gateway_id`); three associations and two propagations (no tags; unknown `transit_gateway_attachment_id`, `transit_gateway_route_table_id`, each by reference); `aws_ec2_transit_gateway_route.spokes_default` { `destination_cidr_block: "0.0.0.0/0"` } unknown attachment (ref `…vpc_attachment.egress`) and table (ref `…route_table.spokes`); `.spokes_blackhole_b` { `destination_cidr_block: b`, `blackhole: true` } refs `destination_cidr_block: ["local.spoke_b_cidr"]`, unknown table only; `aws_route.spoke_a_default`, `.spoke_b_default` (`0.0.0.0/0`) and `.egress_public_slot` { `destination_cidr_block: c.address` } refs `["var.address_space"]`, each with unknown `route_table_id`, `transit_gateway_id` (ref `aws_ec2_transit_gateway.lab`).
  - `compute.tf`: `aws_security_group.vms_a` (`lab-vms-a`, in `vpc-lab`) and `.vms_b` (`lab-vms-b`, `vpc-spoke-b`); ingress `vms_a_icmp`, `vms_b_icmp` { `cidr_ipv4: c.address`, `ip_protocol: "icmp"`, `from_port: -1`, `to_port: -1` } and `vms_a_http`, `vms_b_http` (TCP 80), refs `cidr_ipv4: ["var.address_space"]`; `vms_b_ssh_eice` (ref `aws_security_group.eice_spoke_b`); egress `vms_b_all`; `al2023Instance(c, { key: "a", name: "vm-a", type: "t4g.nano", sgs: ["aws_security_group.vms", "aws_security_group.vms_a"] })` and `al2023Instance(c, { key: "b", name: "vm-b", subnet: "aws_subnet.spoke_b[0]", type: "t4g.nano", sgs: ["aws_security_group.vms_b"] })`, each with `refs.user_data = ["local.cloud_init_base", "local.web_unit", "local.web_runcmd"]` (known at plan, sensitive).

  `lab-plans.test.mjs` proves it, the scope check included.

- [ ] **Step 5: Generate the planned graph and the readme diagram**, check it against "The diagram" above, `GOLDEN["ans-21-transit-gateway"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-21.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-21-transit-gateway`, `npm run labs-topology -- --check ans-21-transit-gateway`, `npm run labs-diagrams -- --check`
Expected: all PASS. (Drafted 2026-10-16: fmt, validate, lint and this test pass; the mock plan applies and its scope check refuses only the transit gateway types Task 3 adds.)

- [ ] **Step 7: Commit**

```bash
git add labs/ans-21-transit-gateway labs/_learning/ans-21-transit-gateway.yaml shared/topology/planned/ans-21-transit-gateway.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-21 transit gateway: segmented spokes, blackhole route, central egress in appliance mode

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 13: Lab ans-22-s2s-vpn

Spec: §12.2 row 22 (implementation, operations, design; expert; explore; £ 0.05; peering optional; 12/10; 2/3; prerequisite 20; VGW, customer gateway, VPN connection (2 tunnels, BGP), "on-prem" VPC with a strongSwan and FRR router on Ubuntu with an EIP) and "Not built here" (Direct Connect, accelerated VPN: readme-only); §5.1 (VPN connection `available`; tunnels may be down); §7.4 (the router's Elastic IP, `PUBLIC_INSTANCE_LABS`); design sheet "Lab 22"; rulings A12, A45, P6, P11.

**Tunnel inside CIDRs (ruling P11, design sheet):** both are left unset. `lab-lint --cloud aws` refuses a written `169.254.x.x/30` (rule `literal-cidr`: only `0.0.0.0/0` and `::/0` may be written; checked 2026-10-16 with `lintTfText`), so AWS chooses each tunnel's /30 from 169.254.0.0/16 and the router reads the chosen addresses from the connection (`tunnel1_cgw_inside_address`, `tunnel1_vgw_inside_address` and tunnel 2's). Nothing else moves: the router's user data already depends on the connection for the outside addresses.

**Files:**
- Create: `labs/ans-22-s2s-vpn/lab.yaml`, `readme.md`
- Create: `labs/ans-22-s2s-vpn/terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged), `variables.tf` (the template's header and seven variables, as lab 20's), `onprem.tf`, `vpn.tf`, `router.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/ans-22-s2s-vpn.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-22-s2s-vpn.mjs`
- Create (generated): `shared/topology/planned/ans-22-s2s-vpn.json`, `shared/guides/ans-22-s2s-vpn/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`, `shared/guides/{index,placement}.json` (generated)
- Test: `scripts/test/labs-aws-ans-22.test.mjs`

**Interfaces:**
- Consumes: the template network; Task 2 (VPN gateway, customer gateway and connection creates; attach and propagation changes; `AssociateAddress` for the router's Elastic IP); Task 3 (the VPN types and `aws_eip_association`; `fromInternet`); Task 4 (P11: the VGW on the lab's own VPC, the propagation on its own route table, the CGW at its own Elastic IP with a private ASN, the connection between its own gateways, never accelerated, private-outside, transit-gateway-ended or logged; rule 11 for `PUBLIC_INSTANCE_LABS`: the router's UDP 500/4500 rules built from the connection's tunnel addresses by reference); Task 6 (VPN connections, then gateways, then customer gateways; `deleting` counted clean); Task 10 (`vpnGateway`, `localNetworkGateway`, the `IPsec, BGP` edge; the EIP association folded into the router).
- The scope check already has `PUBLIC_INSTANCE_LABS = ["ans-22-s2s-vpn"]` (`infra/ci/lab-scope-aws.mjs`), so the Elastic IP association is allowed here only.
- Task 3's `amiProblems` (in `commonAwsProblems`) accepts `data.aws_ssm_parameter.ubuntu_arm64` (the Canonical 24.04 arm64 parameter) only in `PUBLIC_INSTANCE_LABS`, so this lab's `commonAwsProblems` is `[]`; this task never edits `aws-content.mjs`.

**`labs/ans-22-s2s-vpn/lab.yaml`**
```yaml
# Lab ans-22 (AWS labs batch 4). ANS-C01 ((V) the wording against the current
# exam guide): Network Implementation (site-to-site VPN, BGP); Network
# Management and Operation (tunnel status, route propagation, failover);
# Network Design (hybrid connectivity choices; Direct Connect and
# accelerated VPN are readme-only, spec §12.2).
# London list prices × 0.75 (labs-verify --aws-prices); the VPN connection
# and the router's address bill each started hour whole (V, A20; the VPN
# filter is V, Task 23). The router is Ubuntu on a t4g.micro (ruling P11).
id: ans-22-s2s-vpn
version: 1
cloud: aws
title: "Site-to-site VPN with BGP to a pretend data centre"
summary: >-
  A site-to-site VPN from a VPC's virtual private gateway to a pretend data centre: a second VPC whose Ubuntu
  router, behind an Elastic IP, brings up both IPsec tunnels with strongSwan and exchanges routes by BGP with FRR.
exam: ANS-C01
skill_areas: [ans.implementation, ans.operations, ans.design]
level: expert
type: explore
prerequisites: [ans-20-vpc-design]
cost:
  items:
    - name: "Site-to-site VPN connection, hourly"
      gbp_h: 0.0375
      whole_hours: true
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { usagetype: "{usage}-VPN-Usage-Hours:ipsec.1" } }
    - name: "Public IPv4 address (the router's Elastic IP)"
      gbp_h: 0.0038
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - name: "EC2 t4g.micro, Linux (the router)"
      gbp_h: 0.0071
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.micro, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EC2 t4g.nano, Linux (vm-aws)"
      gbp_h: 0.0035
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 2
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "VPN data out, light test traffic", gbp_h: 0.0001 }
    - { name: "EC2 Instance Connect Endpoints (2)", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 12, destroy_min: 10, session_h: 2, max_h: 3 }
capacity: { instance_types: [t4g.micro, t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 2 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/ans-22-s2s-vpn/terraform/onprem.tf`**
```hcl
# onprem.tf
#
# Plain English: lab 22's pretend data centre, vpc-onprem (the slot's second
# /20). One subnet, snet-onprem, holds the router vm-router (router.tf) and
# the VPC's own Instance Connect Endpoint, eice-onprem. Its route table,
# rt-onprem, sends the internet to igw-onprem (the router's Elastic IP is
# how AWS's VPN endpoints reach it) and vpc-lab's range to the router
# itself, as an office's LAN would send it to its VPN box. No route joins
# the two VPCs: the only way between them is the VPN.

locals {
  onprem_cidr        = cidrsubnet(var.address_space, 2, 1)
  onprem_subnet_cidr = cidrsubnet(local.onprem_cidr, 4, 0)
  router_ip          = cidrhost(local.onprem_subnet_cidr, 10)
}

resource "aws_vpc" "onprem" {
  cidr_block           = local.onprem_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-onprem" }
}

resource "aws_subnet" "onprem" {
  vpc_id                  = aws_vpc.onprem.id
  cidr_block              = local.onprem_subnet_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-onprem" }
}

resource "aws_internet_gateway" "onprem" {
  vpc_id = aws_vpc.onprem.id
  tags   = { Name = "igw-onprem" }
}

resource "aws_route_table" "onprem" {
  vpc_id = aws_vpc.onprem.id
  tags   = { Name = "rt-onprem" }
}

resource "aws_route" "onprem_internet" {
  route_table_id         = aws_route_table.onprem.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.onprem.id
}

resource "aws_route" "onprem_to_aws" {
  route_table_id         = aws_route_table.onprem.id
  destination_cidr_block = local.vpc_cidr
  network_interface_id   = aws_instance.router.primary_network_interface_id
}

resource "aws_route_table_association" "onprem" {
  subnet_id      = aws_subnet.onprem.id
  route_table_id = aws_route_table.onprem.id
}

resource "aws_vpc_endpoint" "onprem_s3" {
  vpc_id            = aws_vpc.onprem.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.onprem.id]
  tags              = { Name = "vpce-s3-onprem" }
}

resource "aws_security_group" "eice_onprem" {
  name        = "lab-eice-onprem"
  description = "Instance Connect Endpoint in vpc-onprem: SSH out to vm-router"
  vpc_id      = aws_vpc.onprem.id
  tags        = { Name = "sg-eice-onprem" }
}

resource "aws_vpc_security_group_egress_rule" "eice_onprem_ssh" {
  security_group_id = aws_security_group.eice_onprem.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "onprem" {
  subnet_id          = aws_subnet.onprem.id
  security_group_ids = [aws_security_group.eice_onprem.id]
  preserve_client_ip = false
  tags               = { Name = "eice-onprem" }
}
```

**`labs/ans-22-s2s-vpn/terraform/vpn.tf`**
```hcl
# vpn.tf
#
# Plain English: lab 22's AWS side of the VPN (ruling P11). The virtual
# private gateway vgw-lab, attached to vpc-lab on Amazon's ASN 64512, puts
# the routes it learns by BGP into rt-private. The customer gateway
# cgw-onprem is the router's Elastic IP on ASN 65001. The VPN connection
# vpn-lab has two IPsec tunnels (IKEv2), each with a 32-letter pre-shared
# key made here (they reach the router only in its user data; ruling A12's
# reasoning), and dynamic (BGP) routing. AWS picks each tunnel's /30 inside
# range from 169.254.0.0/16 (a literal range would break the lint's
# literal-cidr rule); the router reads the chosen addresses from this
# connection. Tunnel logs stay off (ruling P8); acceleration, private
# outside addresses and a transit gateway end are never (rule never).

resource "aws_vpn_gateway" "lab" {
  vpc_id          = aws_vpc.lab.id
  amazon_side_asn = 64512
  tags            = { Name = "vgw-lab" }
}

resource "aws_vpn_gateway_route_propagation" "private" {
  vpn_gateway_id = aws_vpn_gateway.lab.id
  route_table_id = aws_route_table.private.id
}

resource "aws_customer_gateway" "onprem" {
  bgp_asn    = 65001
  ip_address = aws_eip.router.public_ip
  type       = "ipsec.1"
  tags       = { Name = "cgw-onprem" }
}

# Letters only: AWS refuses a key that starts with 0, and the router's config needs no quoting.
resource "random_password" "psk1" {
  length  = 32
  special = false
  numeric = false
}

resource "random_password" "psk2" {
  length  = 32
  special = false
  numeric = false
}

resource "aws_vpn_connection" "lab" {
  vpn_gateway_id        = aws_vpn_gateway.lab.id
  customer_gateway_id   = aws_customer_gateway.onprem.id
  type                  = "ipsec.1"
  static_routes_only    = false
  tunnel1_preshared_key = random_password.psk1.result
  tunnel2_preshared_key = random_password.psk2.result
  tunnel1_ike_versions  = ["ikev2"]
  tunnel2_ike_versions  = ["ikev2"]
  tags                  = { Name = "vpn-lab" }
}
```

**`labs/ans-22-s2s-vpn/terraform/router.tf`**
```hcl
# router.tf
#
# Plain English: lab 22's "on-prem" router, vm-router (ruling P11): Ubuntu
# Server 24.04 arm64 on a t4g.micro (strongSwan and FRR come from Ubuntu's
# archive; Amazon Linux has no FRR), at a fixed address in snet-onprem,
# with source/destination checking off because it forwards for its
# network, and the lab's one public instance address, the Elastic IP
# eip-router (spec §7.4). Its security group admits IKE and IPsec (UDP 500
# and 4500) only from the two tunnel outside addresses of the lab's own VPN
# connection, and SSH only from eice-onprem; never anything else from the
# internet. At boot it makes one route-based (VTI) interface per tunnel,
# installs strongSwan and FRR (retrying until the Elastic IP is attached
# and the archive answers), brings both tunnels up from its side and peers
# by BGP with the two AWS inside addresses, advertising vpc-onprem's /20.
# labadmin is in group sudo (Ubuntu has no wheel).

data "aws_ssm_parameter" "ubuntu_arm64" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

locals {
  tunnels = [
    { n = 1, outside = aws_vpn_connection.lab.tunnel1_address, cgw = aws_vpn_connection.lab.tunnel1_cgw_inside_address, vgw = aws_vpn_connection.lab.tunnel1_vgw_inside_address, psk = random_password.psk1.result },
    { n = 2, outside = aws_vpn_connection.lab.tunnel2_address, cgw = aws_vpn_connection.lab.tunnel2_cgw_inside_address, vgw = aws_vpn_connection.lab.tunnel2_vgw_inside_address, psk = random_password.psk2.result },
  ]

  # One VTI per tunnel, keyed (marked) as its swanctl child is; AWS's inside ranges are /30s.
  router_vti = <<-EOT
    #!/bin/sh
    # Lab 22: the two route-based tunnel interfaces (made again at every boot).
    %{for t in local.tunnels~}
    ip link del vti${t.n} 2>/dev/null || true
    ip tunnel add vti${t.n} local ${local.router_ip} remote ${t.outside} mode vti key ${t.n * 100}
    ip addr add ${t.cgw}/30 dev vti${t.n}
    ip link set vti${t.n} up mtu 1419
    sysctl -w net.ipv4.conf.vti${t.n}.disable_policy=1
    %{endfor~}
  EOT

  router_vti_unit = join("\n", [
    "[Unit]",
    "Description=Lab 22 VTI interfaces for the two AWS tunnels",
    "Wants=network-online.target",
    "After=network-online.target",
    "Before=strongswan.service frr.service",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "ExecStart=/usr/local/sbin/lab-vti",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])

  # IKEv2 from the router's side, behind its Elastic IP (NAT traversal on UDP 4500); the IKE identity is the Elastic IP.
  router_swanctl = <<-EOT
    connections {
    %{for t in local.tunnels~}
      aws${t.n} {
        version = 2
        local_addrs = ${local.router_ip}
        remote_addrs = ${t.outside}
        proposals = aes256-sha256-modp2048
        dpd_delay = 10s
        local {
          auth = psk
          id = ${aws_eip.router.public_ip}
        }
        remote {
          auth = psk
          id = ${t.outside}
        }
        children {
          aws${t.n} {
            local_ts = 0.0.0.0/0
            remote_ts = 0.0.0.0/0
            mark_in = ${t.n * 100}
            mark_out = ${t.n * 100}
            esp_proposals = aes256-sha256-modp2048
            start_action = start
            dpd_action = restart
          }
        }
      }
    %{endfor~}
    }
    secrets {
    %{for t in local.tunnels~}
      ike-aws${t.n} {
        id-local = ${aws_eip.router.public_ip}
        id-remote = ${t.outside}
        secret = ${t.psk}
      }
    %{endfor~}
    }
  EOT

  # BGP: ASN 65001 to the virtual private gateway's 64512 over each tunnel, advertising the whole on-prem /20.
  router_frr = <<-EOT
    frr defaults traditional
    hostname vm-router
    log syslog informational
    !
    router bgp ${aws_customer_gateway.onprem.bgp_asn}
     bgp router-id ${local.router_ip}
     no bgp ebgp-requires-policy
     no bgp network import-check
    %{for t in local.tunnels~}
     neighbor ${t.vgw} remote-as ${aws_vpn_gateway.lab.amazon_side_asn}
     neighbor ${t.vgw} timers 10 30
    %{endfor~}
     !
     address-family ipv4 unicast
      network ${local.onprem_cidr}
     exit-address-family
    !
  EOT

  router_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    users = [
      "default",
      { name = "labadmin", groups = ["sudo"], sudo = "ALL=(ALL) NOPASSWD:ALL", shell = "/bin/bash", lock_passwd = false },
    ]
    write_files = [
      { path = "/etc/sysctl.d/90-lab-router.conf", permissions = "0644", content = "net.ipv4.ip_forward = 1\n" },
      { path = "/usr/local/sbin/lab-vti", permissions = "0755", content = local.router_vti },
      { path = "/etc/systemd/system/lab-vti.service", permissions = "0644", content = local.router_vti_unit },
      { path = "/etc/swanctl/conf.d/aws.conf", permissions = "0600", content = local.router_swanctl },
      { path = "/etc/strongswan.d/charon-lab.conf", permissions = "0644", content = "charon {\n  install_routes = no\n}\n" },
      { path = "/usr/local/share/lab/frr.conf", permissions = "0644", content = local.router_frr },
    ]
    runcmd = [
      "sysctl --system",
      "systemctl daemon-reload",
      "systemctl enable --now lab-vti.service",
      "for i in $(seq 1 30); do DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confold strongswan-swanctl charon-systemd frr && break; sleep 10; done",
      "install -m 0640 -o frr -g frr /usr/local/share/lab/frr.conf /etc/frr/frr.conf",
      "sed -i 's/^bgpd=no/bgpd=yes/' /etc/frr/daemons",
      "systemctl restart frr",
      "systemctl enable strongswan",
      "systemctl restart strongswan",
      "swanctl --load-all",
    ]
  }))}"
}

resource "aws_eip" "router" {
  domain = "vpc"
  tags   = { Name = "eip-router" }
}

resource "aws_eip_association" "router" {
  instance_id   = aws_instance.router.id
  allocation_id = aws_eip.router.id
}

resource "aws_security_group" "router" {
  name        = "lab-router"
  description = "vm-router: IKE and IPsec from the two AWS tunnel endpoints, SSH from eice-onprem"
  vpc_id      = aws_vpc.onprem.id
  tags        = { Name = "sg-router" }
}

resource "aws_vpc_security_group_ingress_rule" "router_ike_1" {
  security_group_id = aws_security_group.router.id
  cidr_ipv4         = "${aws_vpn_connection.lab.tunnel1_address}/32"
  ip_protocol       = "udp"
  from_port         = 500
  to_port           = 500
}

resource "aws_vpc_security_group_ingress_rule" "router_ike_2" {
  security_group_id = aws_security_group.router.id
  cidr_ipv4         = "${aws_vpn_connection.lab.tunnel2_address}/32"
  ip_protocol       = "udp"
  from_port         = 500
  to_port           = 500
}

resource "aws_vpc_security_group_ingress_rule" "router_natt_1" {
  security_group_id = aws_security_group.router.id
  cidr_ipv4         = "${aws_vpn_connection.lab.tunnel1_address}/32"
  ip_protocol       = "udp"
  from_port         = 4500
  to_port           = 4500
}

resource "aws_vpc_security_group_ingress_rule" "router_natt_2" {
  security_group_id = aws_security_group.router.id
  cidr_ipv4         = "${aws_vpn_connection.lab.tunnel2_address}/32"
  ip_protocol       = "udp"
  from_port         = 4500
  to_port           = 4500
}

resource "aws_vpc_security_group_ingress_rule" "router_ssh_eice" {
  security_group_id            = aws_security_group.router.id
  referenced_security_group_id = aws_security_group.eice_onprem.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "router_all" {
  security_group_id = aws_security_group.router.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "router" {
  ami                    = data.aws_ssm_parameter.ubuntu_arm64.insecure_value
  instance_type          = "t4g.micro"
  subnet_id              = aws_subnet.onprem.id
  private_ip             = local.router_ip
  source_dest_check      = false
  vpc_security_group_ids = [aws_security_group.router.id]
  user_data              = local.router_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-router" })
  tags        = { Name = "vm-router" }
  depends_on  = [aws_route.onprem_internet, aws_route_table_association.onprem, aws_vpc_endpoint.onprem_s3]
}
```

**`labs/ans-22-s2s-vpn/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 22's instance on the AWS side, vm-aws (t4g.nano,
# Amazon Linux 2023) in snet-private-1, serving a page naming itself. It
# keeps the template's sg-vms (SSH from eice-lab, the VPN server's range
# when peered) and adds sg-aws: ping and HTTP from vpc-onprem's /20, which
# arrive only through the VPN.

locals {
  aws_unit = join("\n", [
    "[Unit]",
    "Description=Lab page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  aws_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-aws in vpc-lab, reached over the VPN\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.aws_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_security_group" "aws" {
  name        = "lab-aws"
  description = "vm-aws: ping and HTTP from the on-prem VPC, through the VPN"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-aws" }
}

resource "aws_vpc_security_group_ingress_rule" "aws_icmp_onprem" {
  security_group_id = aws_security_group.aws.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "aws_http_onprem" {
  security_group_id = aws_security_group.aws.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_instance" "aws" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.aws.id]
  user_data              = local.aws_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-aws" })
  tags        = { Name = "vm-aws" }
  depends_on  = [aws_vpc_endpoint.s3]
}
```

**`labs/ans-22-s2s-vpn/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 22 is up: both
# instances' private addresses, console SSH to each, the two commands that
# show the tunnels and the BGP sessions from the router's side, and, while
# peered, SSH and the page on vm-aws. Only vpc-lab is peered to the VPN
# server; rt-private also carries the route vgw-lab learns by BGP.

output "private_ips" {
  value = { "vm-aws" = aws_instance.aws.private_ip, "vm-router" = aws_instance.router.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.aws.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.router.id} --os-user labadmin --connection-type eice",
    "On vm-router: sudo swanctl --list-sas; sudo vtysh -c 'show ip bgp summary'",
    "ssh labadmin@${aws_instance.aws.private_ip}",
    "curl http://${aws_instance.aws.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

How the pieces wait for each other (no cycle; `terraform validate` and the mock plan agree): `aws_eip.router` → `aws_customer_gateway.onprem` → `aws_vpn_connection.lab` → the router's security group rules and user data → `aws_instance.router` → `aws_eip_association.router` and `aws_route.onprem_to_aws`. The router boots before its Elastic IP is attached, so its package install retries for up to five minutes; the release test never waits for the tunnels (§5.1).

(V) for Task 24, each read on the release test's router (`sudo cloud-init status --long`, `systemctl status strongswan frr lab-vti`, `swanctl --list-sas`) and recorded: the Ubuntu parameter answers (Task 23 Step 1 already reads it); `strongswan-swanctl`, `charon-systemd` and `frr` install on 24.04 arm64 and `charon-systemd` names its unit `strongswan.service` (else the runcmd's two `strongswan` lines name the unit it has, version bump); EC2 Instance Connect pushes a key for `labadmin` on Ubuntu's image (it ships `ec2-instance-connect`); both tunnels Up within ten minutes (a Thing to try, never the test).

**`labs/ans-22-s2s-vpn/readme.md`** (exactly):
````markdown
A site-to-site VPN from AWS to a data centre, where the data centre is pretend: a second VPC whose one router, an Ubuntu instance with a public address, plays the office's VPN box. AWS's end is a virtual private gateway on `vpc-lab`; the router brings up both of AWS's IPsec tunnels with strongSwan and swaps routes with it by BGP using FRR, so neither side has a route to the other typed in. Everything is listed in the lab's resource group, `lab-ans-22-s2s-vpn`, in AWS Resource Groups (London).
From the ANS-C01 outline: implement hybrid connectivity with AWS Site-to-Site VPN and dynamic routing with BGP, and monitor and troubleshoot it.

## What it deploys

- **AWS side**: the virtual private gateway `vgw-lab` (ASN 64512) on `vpc-lab`, putting what it learns by BGP into `rt-private`; the instance `vm-aws` (t4g.nano) in `snet-private-1`, serving a page and admitting ping and HTTP from the on-prem VPC (`sg-aws`)
- **The VPN**: the customer gateway `cgw-onprem` (the router's Elastic IP, ASN 65001) and the VPN connection `vpn-lab`, two IPsec tunnels (IKEv2, a 32-letter pre-shared key each) to two different AWS endpoints, with BGP over each
- **Pretend data centre**: the VPC `vpc-onprem` (the slot's second /20) with the subnet `snet-onprem`, the internet gateway `igw-onprem` and the route table `rt-onprem`, which sends `vpc-lab`'s range to the router as an office LAN would; the router `vm-router` (Ubuntu 24.04, t4g.micro) at a fixed address with the Elastic IP `eip-router`, strongSwan (one route-based tunnel interface per tunnel) and FRR; its security group `sg-router` admits IKE and IPsec (UDP 500 and 4500) only from the two tunnel endpoints and SSH only from `eice-onprem`
- Instance Connect Endpoints `eice-lab` (for `vm-aws`) and `eice-onprem` (for `vm-router`)

The tunnels come up a few minutes after the router boots (it installs strongSwan and FRR first); the lab counts as ready as soon as AWS says the VPN connection is available.

```text
lab-ans-22-s2s-vpn (London)
  vm-aws (vpc-lab, snet-private-1) -- rt-private (BGP-learned on-prem /20) --> vgw-lab (ASN 64512)
  vgw-lab == vpn-lab: tunnel 1 + tunnel 2 (IPsec, IKEv2, BGP) ==> cgw-onprem = eip-router
  eip-router --> vm-router (vpc-onprem, snet-onprem; strongSwan vti1/vti2, FRR ASN 65001)
  rt-onprem: vpc-lab /20 --> vm-router, 0.0.0.0/0 --> igw-onprem
  peering (optional, AWS server only, vpc-lab only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- In the VPC console, open Site-to-Site VPN connections, `vpn-lab`, **Tunnel details**: both tunnels should read **Up** with 1 BGP route each within ten minutes of deploy. Then open `rt-private`'s routes: the on-prem /20 is there, **Propagated: Yes**, to `vgw-lab`.
- Connect to `vm-router` (the second Connect line) and run the third: `sudo swanctl --list-sas` shows both IKE and child security associations, `sudo vtysh -c 'show ip bgp summary'` both neighbours Established with routes received. `sudo vtysh -c 'show ip route bgp'` shows `vpc-lab`'s /20 learned over the two tunnel interfaces.
- From `vm-router`, reach `vm-aws` through the VPN from the router's own address: `ping -I <vm-router's address> <vm-aws's address>` and `curl --interface <vm-router's address> http://<vm-aws's address>` (both addresses are in the dashboard).
- Fail a tunnel: on `vm-router` run `sudo swanctl --terminate --ike aws1`. Watch the console's Tunnel details (tunnel 1 goes Down) and `show ip bgp summary`; a `ping` left running from the router keeps answering through tunnel 2 once BGP notices (up to 30 seconds, the hold time). Bring tunnel 1 back with `sudo swanctl --initiate --child aws1`: AWS waits for the router to start a tunnel, it never starts one itself.
- In the console, choose **Download configuration** on `vpn-lab` (vendor strongSwan) and compare AWS's suggested settings with the router's own files, `/etc/swanctl/conf.d/aws.conf` and `/etc/frr/frr.conf`.

**Not built here** (each needs a physical circuit or costs far more than a lab): AWS Direct Connect (connections, virtual interfaces, link aggregation groups, MACsec, Direct Connect gateways and SiteLink), and accelerated VPN, which runs the tunnels over Global Accelerator's network. Both are in the Learn more links.

## Learn more

- [How AWS Site-to-Site VPN works](https://docs.aws.amazon.com/vpn/latest/s2svpn/how_it_works.html)
- [Site-to-Site VPN tunnel options](https://docs.aws.amazon.com/vpn/latest/s2svpn/VPNTunnels.html)
- [Monitor your Site-to-Site VPN connection](https://docs.aws.amazon.com/vpn/latest/s2svpn/monitoring-overview-vpn.html)
- [Accelerated Site-to-Site VPN connections](https://docs.aws.amazon.com/vpn/latest/s2svpn/accelerated-vpn.html)
- [What is AWS Direct Connect?](https://docs.aws.amazon.com/directconnect/latest/UserGuide/Welcome.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-22-s2s-vpn` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-22-s2s-vpn.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Bring up a site-to-site VPN with BGP between a VPC and a pretend data centre router.
learn:
  - Build two IPsec tunnels from strongSwan to a virtual private gateway
  - Exchange routes by BGP and see them propagate into a route table
  - Fail one tunnel and watch the traffic move to the other
learning_min: 75
```

**The diagram** must contain: `resourceGroup lab-ans-22-s2s-vpn · London`; `vnet vpc-lab` (`subnet snet-private-1/2`), `vnet vpc-onprem` (`subnet snet-onprem`); `vpnGateway vgw-lab < vpc-lab` (its route propagation folds in); `vpnGateway vpn-lab < lab-ans-22-s2s-vpn · London`; `localNetworkGateway cgw-onprem < lab-ans-22-s2s-vpn · London`; `internetGateway igw-onprem < vpc-onprem`; `routeTable rt-private < vpc-lab`, `routeTable rt-onprem < vpc-onprem`; `nsg sg-eice`, `sg-vms`, `sg-aws` (`< vpc-lab`), `sg-eice-onprem`, `sg-router` (`< vpc-onprem`); `vm vm-aws < snet-private-1`, `vm vm-router < snet-onprem` (`eip-router` and its association fold in; the two `random_password`s are not drawn); `bastion eice-lab < snet-private-1`, `bastion eice-onprem < snet-onprem`; `privateEndpoint vpce-s3 < vpc-lab`, `privateEndpoint vpce-s3-onprem < vpc-onprem`. Edges: `vgw-lab -> cgw-onprem : IPsec, BGP`, `rt-onprem ..> igw-onprem : 0.0.0.0/0`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-ans-22.test.mjs`:

```js
// labs-aws-ans-22.test.mjs
//
// Plain English: lab ans-22-s2s-vpn is the lab AWS labs spec §12.2 row 22
// describes: a virtual private gateway, a customer gateway and a VPN
// connection (two tunnels, BGP) to a pretend data centre whose Ubuntu
// router runs strongSwan and FRR behind an Elastic IP (ruling P11, §7.4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-22-s2s-vpn";
const of = (blocks, type) => blocks.filter((b) => b.kind === "resource" && b.labels[0] === type);
const body = (blocks, type, name) => of(blocks, type).find((b) => b.labels[1] === name)?.body ?? "";
const count = (text, re) => [...text.matchAll(re)].length;

test("ans-22 keeps the AWS lab contract; its one exception is ruling P11's Ubuntu router", () => {
  assert.deepEqual(commonAwsProblems(ID), [], "the Ubuntu router is accepted in PUBLIC_INSTANCE_LABS (Task 3's amiProblems)");
  const { blocks } = awsLab(ID);
  assert.match(blocks.find((b) => b.kind === "data" && b.labels[1] === "ubuntu_arm64").body, /name = "\/aws\/service\/canonical\/ubuntu\/server\/24\.04\/stable\/current\/arm64\/hvm\/ebs-gp3\/ami-id"/);
  assert.match(body(blocks, "aws_instance", "router"), /ami\s+= data\.aws_ssm_parameter\.ubuntu_arm64\.insecure_value/);
});

test("ans-22's lab.yaml: §12.2 row 22, after lab 20, about £0.05/h with the VPN connection billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.implementation", "ans.operations", "ans.design"], ["ans-20-vpc-design"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 12, destroy_min: 10, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.micro", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.045 && total < 0.065, `about £0.054/h, got ${total}`);
  const vpn = yaml.cost.items.find((i) => i.name === "Site-to-site VPN connection, hourly");
  assert.deepEqual([vpn.whole_hours, vpn.aws_price.filters.usagetype], [true, "{usage}-VPN-Usage-Hours:ipsec.1"]);
});

test("ruling P11: VGW on 64512 propagating into rt-private, CGW on 65001 at the router's Elastic IP, two IKEv2 tunnels with BGP; nothing accelerated, private or logged", () => {
  const { blocks, files } = awsLab(ID);
  for (const re of [/vpc_id\s+= aws_vpc\.lab\.id/, /amazon_side_asn = 64512/]) assert.match(body(blocks, "aws_vpn_gateway", "lab"), re);
  assert.match(body(blocks, "aws_vpn_gateway_route_propagation", "private"), /route_table_id = aws_route_table\.private\.id/);
  for (const re of [/bgp_asn\s+= 65001/, /ip_address = aws_eip\.router\.public_ip/, /type\s+= "ipsec\.1"/]) assert.match(body(blocks, "aws_customer_gateway", "onprem"), re);
  const vpn = body(blocks, "aws_vpn_connection", "lab");
  for (const re of [/static_routes_only\s+= false/, /tunnel1_preshared_key = random_password\.psk1\.result/, /tunnel2_preshared_key = random_password\.psk2\.result/, /tunnel1_ike_versions\s+= \["ikev2"\]/, /tunnel2_ike_versions\s+= \["ikev2"\]/, /vpn_gateway_id\s+= aws_vpn_gateway\.lab\.id/]) assert.match(vpn, re);
  for (const re of [/enable_acceleration/, /outside_ip_address_type/, /transit_gateway_id/, /log_options/, /inside_cidr/]) assert.doesNotMatch(vpn, re);
  for (const k of ["psk1", "psk2"]) for (const re of [/length\s+= 32/, /special = false/, /numeric = false/]) assert.match(body(blocks, "random_password", k), re, k);
  assert.doesNotMatch(files["vpn.tf"], /"169\.254/, "AWS chooses the inside ranges (no literal CIDR)");
});

test("ruling P11 and §7.4: the router's Elastic IP admits only IKE and NAT-T from the two tunnel endpoints, and SSH only from eice-onprem", () => {
  const { blocks } = awsLab(ID);
  const rules = of(blocks, "aws_vpc_security_group_ingress_rule").filter((b) => b.body.includes("aws_security_group.router.id"));
  assert.equal(rules.length, 5);
  const fromTunnel = rules.filter((b) => /cidr_ipv4\s+= "\$\{aws_vpn_connection\.lab\.tunnel[12]_address\}\/32"/.test(b.body));
  assert.equal(fromTunnel.length, 4);
  for (const b of fromTunnel) assert.match(b.body, /ip_protocol\s+= "udp"\n\s+from_port\s+= (500|4500)\n\s+to_port\s+= \1/);
  assert.match(rules.find((b) => !fromTunnel.includes(b)).body, /referenced_security_group_id = aws_security_group\.eice_onprem\.id/);
  const router = body(blocks, "aws_instance", "router");
  for (const re of [/instance_type\s+= "t4g\.micro"/, /private_ip\s+= local\.router_ip/, /source_dest_check\s+= false/, /subnet_id\s+= aws_subnet\.onprem\.id/]) assert.match(router, re);
  assert.doesNotMatch(router, /associate_public_ip_address/);
  for (const re of [/instance_id\s+= aws_instance\.router\.id/, /allocation_id = aws_eip\.router\.id/]) assert.match(body(blocks, "aws_eip_association", "router"), re);
});

test("ans-22's router configures itself: sudo labadmin, strongSwan with the AWS-chosen inside addresses, FRR on 65001 advertising vpc-onprem, forwarding on", () => {
  const { files } = awsLab(ID);
  const r = files["router.tf"];
  for (const re of [/groups = \["sudo"\]/, /strongswan-swanctl charon-systemd frr/, /tunnel1_cgw_inside_address/, /tunnel1_vgw_inside_address/, /tunnel2_cgw_inside_address/, /tunnel2_vgw_inside_address/, /mode vti key \$\{t\.n \* 100\}/, /start_action = start/, /id = \$\{aws_eip\.router\.public_ip\}/, /router bgp \$\{aws_customer_gateway\.onprem\.bgp_asn\}/, /remote-as \$\{aws_vpn_gateway\.lab\.amazon_side_asn\}/, /network \$\{local\.onprem_cidr\}/, /net\.ipv4\.ip_forward = 1/, /install_routes = no/]) assert.match(r, re);
  const onprem = files["onprem.tf"];
  for (const re of [/onprem_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/, /router_ip\s+= cidrhost\(local\.onprem_subnet_cidr, 10\)/, /destination_cidr_block = local\.vpc_cidr\n\s+network_interface_id\s+= aws_instance\.router\.primary_network_interface_id/]) assert.match(onprem, re);
  assert.equal(count(onprem, /map_public_ip_on_launch = false/g), 1);
});

test("ans-22's readme reads the tunnels from both ends, fails one over, names what is not built, and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["Tunnel details", "Propagated: Yes", "swanctl --list-sas", "show ip bgp summary", "swanctl --terminate --ike aws1", "Download configuration", "Direct Connect", "accelerated VPN"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-ans-22.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; trim `variables.tf` to the seven variables named.

- [ ] **Step 4: Write the plan fixture** `ans-22-s2s-vpn.mjs`: `const c = ctxAws("ans-22-s2s-vpn", "22")`, `const o = cidrsubnet(c.address, 2, 1)`, `const os = cidrsubnet(o, 4, 0)`, `const routerIp` = the 11th address of `os` (`.10`, as saa-16's fixture computes `drIp`), `const UBUNTU = "ami-0a1b2c3d4e5f60718"`; `data: [...awsData(), { address: "data.aws_ssm_parameter.ubuntu_arm64", values: { name: "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id", insecure_value: UBUNTU }, args: ["name"], refs: {} }]`; `resources: [...templateResources(c), …]`:
  - `onprem.tf`: `aws_vpc.onprem` (`o`, `vpc-onprem`, refs `["local.onprem_cidr"]`); `aws_subnet.onprem` (`os`, zone a, `snet-onprem`, refs `["local.onprem_subnet_cidr"]`, `["local.azs"]`); `aws_internet_gateway.onprem`; `aws_route_table.onprem`; `aws_route.onprem_internet` (`0.0.0.0/0`, unknown `gateway_id`); `aws_route.onprem_to_aws` { `destination_cidr_block: c.vpcCidr` } refs `["local.vpc_cidr"]`, unknown `route_table_id`, `network_interface_id` (ref `aws_instance.router` `primary_network_interface_id`); `aws_route_table_association.onprem`; `aws_vpc_endpoint.onprem_s3`; `aws_security_group.eice_onprem` (`lab-eice-onprem`) and its egress rule (`cidr_ipv4: o`); `aws_ec2_instance_connect_endpoint.onprem` (unknown `subnet_id` ref `aws_subnet.onprem`, `security_group_ids.0`).
  - `vpn.tf`: `aws_vpn_gateway.lab` { `amazon_side_asn: "64512"`, `vgw-lab` } unknown `vpc_id` (ref `aws_vpc.lab`); `aws_vpn_gateway_route_propagation.private` (no tags; unknown `vpn_gateway_id`, `route_table_id` ref `aws_route_table.private`); `aws_customer_gateway.onprem` { `bgp_asn: "65001"`, `type: "ipsec.1"`, `cgw-onprem` } unknown `ip_address` (ref `aws_eip.router` `public_ip`); `random_password.psk1`, `.psk2` { `length: 32`, `special: false`, `numeric: false` } (no tags; `result` computed, sensitive); `aws_vpn_connection.lab` { `type: "ipsec.1"`, `static_routes_only: false`, `tunnel1_ike_versions: ["ikev2"]`, `tunnel2_ike_versions: ["ikev2"]`, `vpn-lab` }, unknown and sensitive `tunnel1_preshared_key`, `tunnel2_preshared_key` (refs `random_password.psk1` / `psk2` `result`), unknown `vpn_gateway_id`, `customer_gateway_id` (by reference).
  - `router.tf`: `aws_eip.router` (`domain: "vpc"`, `eip-router`); `aws_eip_association.router` (no tags; unknown `instance_id`, `allocation_id`, by reference); `aws_security_group.router` (`lab-router`); `router_ike_1`, `router_ike_2`, `router_natt_1`, `router_natt_2` { `ip_protocol: "udp"`, ports 500 or 4500 } with unknown `cidr_ipv4` (refs `aws_vpn_connection.lab` `tunnel1_address` / `tunnel2_address`) and `security_group_id`; `router_ssh_eice` (ref `aws_security_group.eice_onprem`); egress `router_all`; the router: `al2023Instance(c, { key: "router", name: "vm-router", subnet: "aws_subnet.onprem", type: "t4g.micro", sgs: ["aws_security_group.router"], userDataUnknown: true })` with `values.ami = UBUNTU`, `values.private_ip = routerIp`, `values.source_dest_check = false`, `refs.ami = ["data.aws_ssm_parameter.ubuntu_arm64.insecure_value", "data.aws_ssm_parameter.ubuntu_arm64"]`, `refs.private_ip = ["local.router_ip"]`, `refs.user_data = ["local.router_cloud_init"]` (unknown at plan: it holds the connection's tunnel addresses, inside addresses and the Elastic IP; sensitive).
  - `compute.tf`: `aws_security_group.aws` (`lab-aws`); `aws_icmp_onprem` (`icmp`, `-1`, `-1`) and `aws_http_onprem` (TCP 80), `cidr_ipv4: o`, refs `["local.onprem_cidr"]`; `al2023Instance(c, { key: "aws", name: "vm-aws", type: "t4g.nano", sgs: ["aws_security_group.vms", "aws_security_group.aws"] })` with `refs.user_data = ["local.aws_cloud_init"]`.

  `lab-plans.test.mjs` proves it, the scope check included (rule 11 reads the router's four tunnel rules by reference, P11).

- [ ] **Step 5: Generate the planned graph and the readme diagram**, check it against "The diagram" above, `GOLDEN["ans-22-s2s-vpn"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-22.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-22-s2s-vpn`, `npm run labs-topology -- --check ans-22-s2s-vpn`, `npm run labs-diagrams -- --check`
Expected: all PASS. (Drafted 2026-10-16: fmt, validate, lint and this test pass; the mock plan applies and its scope check refuses only the VPN types and `aws_eip_association` Task 3 adds.)

- [ ] **Step 7: Commit**

```bash
git add labs/ans-22-s2s-vpn labs/_learning/ans-22-s2s-vpn.yaml shared/topology/planned/ans-22-s2s-vpn.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-22 site-to-site VPN with BGP to a strongSwan and FRR router in a pretend data centre

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 14: Lab ans-23-hybrid-dns

Spec: §12.2 row 23 (design, implementation, security; expert; explore; ££ 0.38; peering optional; 8/8; 2/3; prerequisite 20; inbound and outbound endpoints, forwarding rule, "on-prem" DNS server on EC2 (dnsmasq), private hosted zone, DNS Firewall, query logging); §4; §7.5 (a VPC passed as a parameter); rulings A11, A45, A87, A88, P1, P7, P8, P12, P21. Design sheet: Lab 23.

**Files:**
- Create: `labs/ans-23-hybrid-dns/lab.yaml`, `readme.md`
- Create: `labs/ans-23-hybrid-dns/terraform/versions.tf`, `main.tf`, `network.tf` (all three copied unchanged from `labs/_template-aws/`), `variables.tf` (the template's header and its `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password` and `tags` blocks, verbatim), `onprem.tf`, `resolver.tf`, `dnsfw.tf`, `querylog.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/ans-23-hybrid-dns.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-23-hybrid-dns.mjs`
- Create (generated): `shared/topology/planned/ans-23-hybrid-dns.json`, `shared/guides/ans-23-hybrid-dns/**`
- Modify: `shared/guides/{index,placement}.json` (generated), `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-ans-23.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`AWS_DNS_LABS` holds `ans-23-hybrid-dns`, so `LAB_REGIONS` is `eu-west-2 eu-west-1 us-east-1` and the safety net, Verify clean and the Worker list the private zone in us-east-1); Task 2 (`route53resolver` made ahead; the Resolver creates and changes in the table); Task 3 (the nine Resolver types on `AWS_TYPES`; rule `public`'s P7 clause on the bucket policy); Task 4 (`batch4Problems`: the endpoints' subnets and groups by reference, `Do53` only, the rule `FORWARD` to a `.internal` name and a slot address, the associations on the lab's own VPC, mutation protection off, the query log config to the lab's bucket); Task 5 (Resolver clean-up in P23's order, endpoints waited for); Task 10 (`dnsResolver`, `dnsRuleset`, `generic` cards for the rule group and the query log config). The ready check's existing `route53resolver:resolver-endpoint` case (OPERATIONAL) is what "ready" waits for.

**`labs/ans-23-hybrid-dns/lab.yaml`**
```yaml
# Lab ans-23 (AWS labs batch 4). ANS-C01 ((V) the wording against the current
# exam guide): Network Design (hybrid DNS); Network Implementation (Route 53
# Resolver endpoints and rules); Network Security, Compliance, and Governance
# (DNS Firewall, query logging).
# London list prices × 0.75 (labs-verify --aws-prices). A Resolver endpoint
# bills each of its network interfaces by the hour (two each, AWS's minimum:
# four here), believed by the started hour (V, A20). The private zone bills by
# the month (a zone deleted within 12 hours is believed not to be charged,
# spec §15, V); DNS Firewall, Resolver queries and the S3 query logs bill per
# use (authored).
id: ans-23-hybrid-dns
version: 1
cloud: aws
title: "Hybrid DNS with Route 53 Resolver"
summary: >-
  A cloud VPC and a pretend data centre with its own DNS server (dnsmasq), joined so each can resolve the other's
  private names through Route 53 Resolver inbound and outbound endpoints and a forwarding rule, with a private hosted
  zone, a DNS Firewall rule blocking a domain, and query logs to S3.
exam: ANS-C01
skill_areas: [ans.design, ans.implementation, ans.security]
level: expert
type: explore
prerequisites: [ans-20-vpc-design]
cost:
  items:
    - name: "Route 53 Resolver endpoint network interfaces (2 endpoints, 2 each)"
      gbp_h: 0.0938
      qty: 4
      whole_hours: true
      aws_price: { service: AmazonRoute53, unit: Hrs, filters: { usagetype: "{usage}-ResolverNetworkInterface" } }
    - name: "EC2 t4g.nano, Linux (vm-cloud and vm-dns)"
      gbp_h: 0.0035
      qty: 2
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 2
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "Route 53 private hosted zone ($0.50 a month)", gbp_h: 0.0005 }
    - { name: "DNS Firewall and Resolver queries, light test traffic", gbp_h: 0.0001 }
    - { name: "Query logs to S3, a few kB", gbp_h: 0.0001 }
    - { name: "EC2 Instance Connect Endpoints (2) and VPC peering in one Region", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 8, destroy_min: 8, session_h: 2, max_h: 3 }
capacity: { instance_types: [t4g.nano, t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 2 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/ans-23-hybrid-dns/terraform/onprem.tf`**
```hcl
# onprem.tf
#
# Plain English: lab 23's pretend data centre, vpc-onprem (the slot's second
# /20), peered to the cloud VPC (the template's vpc-lab) by the lab itself,
# with a route each way. Its one subnet, snet-onprem-1, holds the "on-prem"
# DNS server vm-dns at a fixed address (local.dns_ip) and the VPC's own
# Instance Connect Endpoint; a free S3 gateway endpoint lets vm-dns install
# dnsmasq with no NAT gateway (ruling A11). The endpoint is made after vm-dns,
# so it can never take the fixed address first.

locals {
  onprem_cidr        = cidrsubnet(var.address_space, 2, 1)
  onprem_subnet_cidr = cidrsubnet(local.onprem_cidr, 4, 0)
  dns_ip             = cidrhost(local.onprem_subnet_cidr, 10)
}

resource "aws_vpc" "onprem" {
  cidr_block           = local.onprem_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-onprem" }
}

resource "aws_subnet" "onprem" {
  vpc_id                  = aws_vpc.onprem.id
  cidr_block              = local.onprem_subnet_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-onprem-1" }
}

resource "aws_route_table" "onprem" {
  vpc_id = aws_vpc.onprem.id
  tags   = { Name = "rt-onprem" }
}

resource "aws_route_table_association" "onprem" {
  subnet_id      = aws_subnet.onprem.id
  route_table_id = aws_route_table.onprem.id
}

resource "aws_vpc_endpoint" "onprem_s3" {
  vpc_id            = aws_vpc.onprem.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.onprem.id]
  tags              = { Name = "vpce-s3-onprem" }
}

resource "aws_vpc_peering_connection" "cloud_onprem" {
  vpc_id      = aws_vpc.lab.id
  peer_vpc_id = aws_vpc.onprem.id
  auto_accept = true
  tags        = { Name = "pcx-cloud-onprem" }
}

resource "aws_route" "cloud_to_onprem" {
  route_table_id            = aws_route_table.private.id
  destination_cidr_block    = local.onprem_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.cloud_onprem.id
}

resource "aws_route" "onprem_to_cloud" {
  route_table_id            = aws_route_table.onprem.id
  destination_cidr_block    = local.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.cloud_onprem.id
}

resource "aws_security_group" "eice_onprem" {
  name        = "lab-eice-onprem"
  description = "Instance Connect Endpoint in vpc-onprem: SSH out to vm-dns"
  vpc_id      = aws_vpc.onprem.id
  tags        = { Name = "sg-eice-onprem" }
}

resource "aws_vpc_security_group_egress_rule" "eice_onprem_ssh" {
  security_group_id = aws_security_group.eice_onprem.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "onprem" {
  subnet_id          = aws_subnet.onprem.id
  security_group_ids = [aws_security_group.eice_onprem.id]
  preserve_client_ip = false
  tags               = { Name = "eice-onprem" }
  depends_on         = [aws_instance.dns]
}
```

**`labs/ans-23-hybrid-dns/terraform/resolver.tf`**
```hcl
# resolver.tf
#
# Plain English: lab 23's Route 53 Resolver in the cloud VPC (ruling P12).
# An inbound endpoint, rslvr-in, that the data centre's DNS server asks about
# cloud names, and an outbound endpoint, rslvr-out, through which the cloud
# VPC asks the data centre about corp names: each with an address in both
# private subnets, at fixed host numbers (.10 inbound, .11 outbound) so
# dnsmasq's configuration can name them before they exist (the template's
# eice-lab, made alongside, takes a random snet-private-1 address: about one
# deploy in 125 meets .10 or .11 taken and fails; Task 24 has the fallback).
# One FORWARD rule,
# corp.<name_prefix>.internal to dnsmasq, used by vpc-lab. And the private
# hosted zone cloud.<name_prefix>.internal (ruling A88: an .internal name)
# with one record, app, vm-cloud's address. The rule's association waits 20
# seconds after the rule is made (ruling P21: Resolver's tags are not yet
# proven to be readable at once).

locals {
  corp_domain  = "corp.${var.name_prefix}.internal"
  cloud_domain = "cloud.${var.name_prefix}.internal"
  inbound_ips  = [for k in [0, 1] : cidrhost(cidrsubnet(local.vpc_cidr, 4, k), 10)]
  outbound_ips = [for k in [0, 1] : cidrhost(cidrsubnet(local.vpc_cidr, 4, k), 11)]
}

resource "aws_security_group" "resolver" {
  name        = "lab-resolver"
  description = "Resolver endpoints: DNS in from the data centre, DNS out to vm-dns"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-resolver" }
}

resource "aws_vpc_security_group_ingress_rule" "resolver_udp" {
  security_group_id = aws_security_group.resolver.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_ingress_rule" "resolver_tcp" {
  security_group_id = aws_security_group.resolver.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "resolver_out_udp" {
  security_group_id = aws_security_group.resolver.id
  cidr_ipv4         = "${local.dns_ip}/32"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "resolver_out_tcp" {
  security_group_id = aws_security_group.resolver.id
  cidr_ipv4         = "${local.dns_ip}/32"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}

resource "aws_route53_resolver_endpoint" "inbound" {
  name               = "lab-${var.lab_id}-in"
  direction          = "INBOUND"
  security_group_ids = [aws_security_group.resolver.id]
  protocols          = ["Do53"]

  ip_address {
    subnet_id = aws_subnet.private[0].id
    ip        = local.inbound_ips[0]
  }
  ip_address {
    subnet_id = aws_subnet.private[1].id
    ip        = local.inbound_ips[1]
  }
  tags = { Name = "rslvr-in" }
}

resource "aws_route53_resolver_endpoint" "outbound" {
  name               = "lab-${var.lab_id}-out"
  direction          = "OUTBOUND"
  security_group_ids = [aws_security_group.resolver.id]
  protocols          = ["Do53"]

  ip_address {
    subnet_id = aws_subnet.private[0].id
    ip        = local.outbound_ips[0]
  }
  ip_address {
    subnet_id = aws_subnet.private[1].id
    ip        = local.outbound_ips[1]
  }
  tags = { Name = "rslvr-out" }
}

resource "aws_route53_resolver_rule" "corp" {
  name                 = "lab-${var.lab_id}-corp"
  rule_type            = "FORWARD"
  domain_name          = local.corp_domain
  resolver_endpoint_id = aws_route53_resolver_endpoint.outbound.id

  target_ip {
    ip   = local.dns_ip
    port = 53
  }
  tags = { Name = "rule-corp" }
}

# Ruling P21: the first tag-checked change on each new Resolver item waits 20 seconds after its create.
resource "time_sleep" "resolver_tags" {
  create_duration = "20s"
  depends_on = [
    aws_route53_resolver_rule.corp,
    aws_route53_resolver_firewall_domain_list.blocked,
    aws_route53_resolver_firewall_rule_group.lab,
    aws_route53_resolver_query_log_config.lab,
  ]
}

resource "aws_route53_resolver_rule_association" "corp" {
  name             = "lab-${var.lab_id}-corp"
  resolver_rule_id = aws_route53_resolver_rule.corp.id
  vpc_id           = aws_vpc.lab.id
  depends_on       = [time_sleep.resolver_tags]
}

resource "aws_route53_zone" "cloud" {
  name          = local.cloud_domain
  force_destroy = true

  vpc {
    vpc_id     = aws_vpc.lab.id
    vpc_region = var.region
  }
  tags = { Name = "zone-cloud" }
}

resource "aws_route53_record" "app" {
  zone_id = aws_route53_zone.cloud.zone_id
  name    = "app.${local.cloud_domain}"
  type    = "A"
  ttl     = 60
  records = [aws_instance.cloud.private_ip]
}
```

**`labs/ans-23-hybrid-dns/terraform/dnsfw.tf`**
```hcl
# dnsfw.tf
#
# Plain English: lab 23's DNS Firewall on the cloud VPC. A domain list,
# lab-<id>-blocked (example.com and every name under it), a rule group with
# one rule that answers NXDOMAIN ("no such name") for anything on the list,
# and the group's association with vpc-lab. Only vpc-lab is filtered: the
# data centre's VPC asks Amazon's resolver unfiltered, which is the
# comparison the readme suggests. Mutation protection is off, so tear-down
# can remove the association.

resource "aws_route53_resolver_firewall_domain_list" "blocked" {
  name    = "lab-${var.lab_id}-blocked"
  domains = ["example.com.", "*.example.com."]
  tags    = { Name = "dnsfw-blocked" }
}

resource "aws_route53_resolver_firewall_rule_group" "lab" {
  name = "lab-${var.lab_id}-dnsfw"
  tags = { Name = "dnsfw-group" }
}

resource "aws_route53_resolver_firewall_rule" "block" {
  name                    = "block"
  action                  = "BLOCK"
  block_response          = "NXDOMAIN"
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.blocked.id
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.lab.id
  priority                = 100
  depends_on              = [time_sleep.resolver_tags]
}

resource "aws_route53_resolver_firewall_rule_group_association" "lab" {
  name                   = "lab-${var.lab_id}-dnsfw"
  firewall_rule_group_id = aws_route53_resolver_firewall_rule_group.lab.id
  vpc_id                 = aws_vpc.lab.id
  priority               = 101
  mutation_protection    = "DISABLED"
  tags                   = { Name = "dnsfw-vpc-lab" }
  depends_on             = [aws_route53_resolver_firewall_rule.block]
}
```

**`labs/ans-23-hybrid-dns/terraform/querylog.tf`**
```hcl
# querylog.tf
#
# Plain English: lab 23's Resolver query logs: every DNS question asked in
# vpc-lab, written as files to the lab's own bucket,
# cloudlabs-<name_prefix>-dnslogs (ruling P8: vended logs go to the lab's
# bucket, never CloudWatch Logs, whose delivery would write an account-wide
# policy). The bucket is private and removable; its policy lets AWS's log
# delivery service write under AWSLogs/<account>/ and check the bucket's ACL,
# and only for this account (ruling P7: aws:SourceAccount). The policy is
# known at plan, built from the caller identity (ruling A68). The VPC's
# association waits 20 seconds after the config is made (ruling P21).

locals {
  dnslogs_bucket = "cloudlabs-${var.name_prefix}-dnslogs"
  dnslogs_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-dnslogs"
}

resource "aws_s3_bucket" "dnslogs" {
  bucket        = local.dnslogs_bucket
  force_destroy = true
  tags          = { Name = "dnslogs" }
}

resource "aws_s3_bucket_public_access_block" "dnslogs" {
  bucket                  = aws_s3_bucket.dnslogs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "dnslogs" {
  bucket = aws_s3_bucket.dnslogs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSLogDeliveryWrite"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${local.dnslogs_arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = { StringEquals = { "s3:x-amz-acl" = "bucket-owner-full-control", "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
      {
        Sid       = "AWSLogDeliveryAclCheck"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = local.dnslogs_arn
        Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.dnslogs]
}

resource "aws_route53_resolver_query_log_config" "lab" {
  name            = "lab-${var.lab_id}-queries"
  destination_arn = aws_s3_bucket.dnslogs.arn
  tags            = { Name = "querylog" }
  depends_on      = [aws_s3_bucket_policy.dnslogs]
}

resource "aws_route53_resolver_query_log_config_association" "lab" {
  resolver_query_log_config_id = aws_route53_resolver_query_log_config.lab.id
  resource_id                  = aws_vpc.lab.id
  depends_on                   = [time_sleep.resolver_tags]
}
```

**`labs/ans-23-hybrid-dns/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 23's two instances (t4g.nano, Amazon Linux 2023).
# vm-cloud, in vpc-lab, serves a page naming itself and has dig (bind-utils);
# it is made after the Resolver endpoints so it never takes one of their
# fixed addresses. vm-dns, the data centre's DNS server, at local.dns_ip in
# vpc-onprem, runs dnsmasq (from Amazon Linux's own repository, through the
# S3 endpoint) as lab-dns.service, on its own address only (Amazon Linux's
# systemd-resolved keeps 127.0.0.53): it answers app.corp.<prefix>.internal
# itself and nothing else under corp, forwards cloud.<prefix>.internal to the
# Resolver's inbound endpoint, and everything else to Amazon's DNS. Each
# admits SSH from its VPC's Instance Connect Endpoint and, once peered, SSH
# and HTTP from the VPN server's VPC (ruling A45); vm-dns admits DNS from the
# whole slot, vm-cloud HTTP from the data centre.

locals {
  cloud_unit = join("\n", [
    "[Unit]",
    "Description=Lab 23 page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"vm-cloud in vpc-lab, app.${local.cloud_domain}\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  cloud_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.cloud_unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-web.service", "for i in 1 2 3 4 5; do dnf install -y bind-utils && break; sleep 10; done"]
  }))}"

  dnsmasq_conf = join("\n", [
    "# Lab 23: the pretend data centre's DNS server.",
    "listen-address=${local.dns_ip}",
    "bind-interfaces",
    "no-resolv",
    "no-hosts",
    "log-queries",
    "log-facility=-",
    "server=169.254.169.253",
    "local=/${local.corp_domain}/",
    "address=/app.${local.corp_domain}/${local.dns_ip}",
    "server=/${local.cloud_domain}/${local.inbound_ips[0]}",
    "server=/${local.cloud_domain}/${local.inbound_ips[1]}",
    "",
  ])
  dns_unit = join("\n", [
    "[Unit]",
    "Description=Lab 23 on-prem DNS (dnsmasq)",
    "After=network-online.target",
    "Wants=network-online.target",
    "[Service]",
    "ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --conf-file=/etc/lab-dnsmasq.conf",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  dns_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/etc/lab-dnsmasq.conf", permissions = "0644", content = local.dnsmasq_conf },
      { path = "/etc/systemd/system/lab-dns.service", permissions = "0644", content = local.dns_unit },
    ]
    runcmd = [
      "for i in 1 2 3 4 5; do dnf install -y dnsmasq bind-utils && break; sleep 10; done",
      "systemctl daemon-reload",
      "systemctl enable --now lab-dns.service",
    ]
  }))}"
}

resource "aws_security_group" "cloud" {
  name        = "lab-cloud"
  description = "vm-cloud: SSH from the Instance Connect Endpoint, HTTP from the data centre, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-cloud" }
}

resource "aws_vpc_security_group_ingress_rule" "cloud_ssh_eice" {
  security_group_id            = aws_security_group.cloud.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "cloud_http_onprem" {
  security_group_id = aws_security_group.cloud.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "cloud_ssh_gateway" {
  security_group_id = aws_security_group.cloud.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "cloud_http_gateway" {
  security_group_id = aws_security_group.cloud.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "cloud_all" {
  security_group_id = aws_security_group.cloud.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "dns" {
  name        = "lab-dns"
  description = "vm-dns: DNS from the slot, SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.onprem.id
  tags        = { Name = "sg-dns" }
}

resource "aws_vpc_security_group_ingress_rule" "dns_udp" {
  security_group_id = aws_security_group.dns.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_ingress_rule" "dns_tcp" {
  security_group_id = aws_security_group.dns.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_ingress_rule" "dns_ssh_eice" {
  security_group_id            = aws_security_group.dns.id
  referenced_security_group_id = aws_security_group.eice_onprem.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "dns_ssh_gateway" {
  security_group_id = aws_security_group.dns.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "dns_http_gateway" {
  security_group_id = aws_security_group.dns.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "dns_all" {
  security_group_id = aws_security_group.dns.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "cloud" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.cloud.id]
  user_data              = local.cloud_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-cloud" })
  tags        = { Name = "vm-cloud" }
  depends_on  = [aws_vpc_endpoint.s3, aws_route53_resolver_endpoint.inbound, aws_route53_resolver_endpoint.outbound]
}

resource "aws_instance" "dns" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.onprem.id
  private_ip             = local.dns_ip
  vpc_security_group_ids = [aws_security_group.dns.id]
  user_data              = local.dns_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-dns" })
  tags        = { Name = "vm-dns" }
  depends_on  = [aws_vpc_endpoint.onprem_s3, aws_route_table_association.onprem]
}
```

**`labs/ans-23-hybrid-dns/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 23 is up: the two
# instances and the Resolver's four fixed addresses, how to connect to each
# instance, the three lookups the readme's Things to try start from, and,
# while peered, SSH and the page on vm-cloud. vpc-lab is the hub the
# pipeline peers to the VPN server's VPC.

output "private_ips" {
  value = {
    "vm-cloud"                      = aws_instance.cloud.private_ip
    "vm-dns"                        = aws_instance.dns.private_ip
    "Resolver inbound (rslvr-in)"   = join(", ", local.inbound_ips)
    "Resolver outbound (rslvr-out)" = join(", ", local.outbound_ips)
  }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.cloud.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.dns.id} --os-user labadmin --connection-type eice",
    "From vm-cloud: dig app.${local.corp_domain}",
    "From vm-dns: dig @${local.dns_ip} app.${local.cloud_domain}",
    "From vm-cloud: dig example.com (DNS Firewall answers NXDOMAIN)",
    "ssh labadmin@${aws_instance.cloud.private_ip}",
    "curl http://${aws_instance.cloud.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/ans-23-hybrid-dns/readme.md`** (exactly):
````markdown
Hybrid DNS the way most companies run it: a cloud VPC and a data centre that each keep their own private names, and Route 53 Resolver joining them in both directions. The data centre here is pretend (a second VPC with a dnsmasq server), but every AWS piece is the real thing: inbound and outbound Resolver endpoints, a forwarding rule, a private hosted zone, a DNS Firewall rule and query logging to S3. Everything is listed in the lab's resource group, `lab-ans-23-hybrid-dns`, in AWS Resource Groups (London); the private hosted zone is a global Route 53 item, under Route 53 in the console.
From the ANS-C01 outline: design DNS solutions that meet public, private and hybrid requirements; implement Route 53 Resolver endpoints and forwarding rules; protect and log DNS with DNS Firewall and query logging.

## What it deploys

- **Cloud**: the VPC `vpc-lab` with `vm-cloud` (t4g.nano, a page naming itself) and the private hosted zone `cloud.<name prefix>.internal`, whose record `app` is vm-cloud's address
- **Data centre**: the VPC `vpc-onprem` (the slot's second /20), peered to `vpc-lab` by the lab itself (`pcx-cloud-onprem`), with `vm-dns`, a dnsmasq server at a fixed address that answers `app.corp.<name prefix>.internal` itself and sends questions about `cloud.<name prefix>.internal` to AWS
- **Resolver inbound endpoint** `rslvr-in`: two addresses in `vpc-lab` (host .10 in each private subnet) that vm-dns forwards cloud questions to
- **Resolver outbound endpoint** `rslvr-out` (host .11) and the forwarding rule `rule-corp`: anything in `vpc-lab` that asks about `corp.<name prefix>.internal` is sent through it to vm-dns
- **DNS Firewall**: the rule group `dnsfw-group` on `vpc-lab`, with one rule that answers NXDOMAIN for `example.com` and every name under it
- **Query logging**: every question asked in `vpc-lab` is written to the bucket `cloudlabs-<name prefix>-dnslogs`

It takes about 8 minutes: the two Resolver endpoints are the slow part.

```text
lab-ans-23-hybrid-dns (London)
  vm-cloud (vpc-lab) --"app.corp?"--> VPC resolver --rule-corp--> rslvr-out (.11) --peering--> vm-dns dnsmasq (vpc-onprem)
  vm-dns dnsmasq --"app.cloud?"--> rslvr-in (.10) --> private zone cloud.<prefix>.internal --> vm-cloud's address
  vpc-lab questions --> DNS Firewall (example.com: NXDOMAIN) --> query logs --> cloudlabs-<prefix>-dnslogs
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Cloud asks the data centre: connect to `vm-cloud` (the first Connect line) and run `dig app.corp.<name prefix>.internal` (the third line). The answer is vm-dns's address. In a second tab connect to `vm-dns` and run `sudo journalctl -u lab-dns -f` while you ask again: the question arrives from `rslvr-out`'s .11 addresses, not from vm-cloud, because the outbound endpoint asks on its behalf.
- The data centre asks the cloud: on `vm-dns` run the fourth Connect line, `dig @<vm-dns address> app.cloud.<name prefix>.internal`. dnsmasq forwards it to `rslvr-in`, which answers from the private zone. Then `curl http://$(dig +short @<vm-dns address> app.cloud.<name prefix>.internal)` fetches vm-cloud's page across the peering by name.
- DNS Firewall: on `vm-cloud` run `dig example.com` and `dig www.example.com`: both NXDOMAIN, while `dig aws.amazon.com` answers. On `vm-dns` run `dig example.com` (Amazon's resolver in `vpc-onprem`, which has no firewall association): it answers. In the Route 53 Resolver console, DNS Firewall, `dnsfw-group`, change the rule's action to Alert and see `vm-cloud` get an answer again.
- Query logs: after about ten minutes, open the bucket `cloudlabs-<name prefix>-dnslogs` in the S3 console. Under `AWSLogs/<account>/vpcdnsquerylogs/` are compressed files, one JSON line per question: open one and find your `example.com` question with its `BLOCK` firewall action, and the corp question with the rule that forwarded it.
- Turn the forwarding off: in the Route 53 Resolver console, Rules, `lab-ans-23-hybrid-dns-corp`, disassociate `vpc-lab`, and ask the corp question again from `vm-cloud`: NXDOMAIN, because Amazon's resolver has never heard of `corp`. Associate it again to put it back.

## Learn more

- [What is Amazon Route 53 Resolver?](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver.html)
- [Forwarding inbound DNS queries to your VPCs](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-forwarding-inbound-queries.html)
- [Forwarding outbound DNS queries to your network](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-forwarding-outbound-queries.html)
- [Route 53 Resolver DNS Firewall](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-dns-firewall.html)
- [Resolver query logging](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-query-logs.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-23-hybrid-dns` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-23-hybrid-dns.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Resolve private names both ways between a VPC and a data centre with Route 53 Resolver, then filter and log them.
learn:
  - Forward cloud questions to a data centre through an outbound endpoint
  - Answer a data centre's questions through an inbound endpoint
  - Block a domain with DNS Firewall and read the query logs
learning_min: 75
```

**The diagram** must contain: `resourceGroup lab-ans-23-hybrid-dns · London`; `vnet vpc-lab` with `subnet snet-private-1/2`; `vnet vpc-onprem` with `subnet snet-onprem-1`; a `traffic` edge `peering` between `vpc-lab` and `vpc-onprem`; `vm vm-cloud`, `vm vm-dns`; `dnsResolver rslvr-in`, `rslvr-out`; `dnsRuleset rule-corp` with a `dependency` edge `forwards` from `rslvr-out`; `dnsZone zone-cloud`; `generic dnsfw-group` (the domain list, rule and association fold into it, ruling P22); `generic querylog` (its association folds in); `storage dnslogs`; `routeTable rt-private`, `rt-onprem`; `nsg sg-eice`, `sg-vms`, `sg-resolver`, `sg-cloud`, `sg-eice-onprem`, `sg-dns`; `bastion eice-lab`, `eice-onprem`; `privateEndpoint vpce-s3`, `vpce-s3-onprem`. No card for the rule association, the firewall rule, the domain list, the query-log association or `time_sleep`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-ans-23.test.mjs`:

```js
// labs-aws-ans-23.test.mjs
//
// Plain English: lab ans-23-hybrid-dns is the lab AWS labs spec §12.2 row 23
// describes: Route 53 Resolver inbound and outbound endpoints, a forwarding
// rule to an "on-prem" dnsmasq server, a private hosted zone, DNS Firewall and
// query logging to the lab's bucket (rulings P1, P7, P8, P12, P21).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_DNS_LABS, AWS_GLOBAL_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "ans-23-hybrid-dns";
/** The body of resource `type`.`name` (or the first of `type`). */
const block = (type, name) => awsLab(ID).blocks.find((b) => b.kind === "resource" && b.labels[0] === type && (name === undefined || b.labels[1] === name))?.body ?? "";

test("ans-23 keeps the AWS lab contract and lists its private zone in us-east-1 (ruling P1)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.ok(AWS_DNS_LABS.includes(ID) && !AWS_GLOBAL_LABS.includes(ID));
  assert.deepEqual(awsLab(ID).yaml.regions, { secondary: null });
});

test("ans-23's lab.yaml: §12.2 row 23, about £0.38/h, four Resolver interfaces billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.implementation", "ans.security"], ["ans-20-vpc-design"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 8, destroy_min: 8, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.36 && total < 0.4, `about £0.38/h, got ${total}`);
  const r = yaml.cost.items.find((i) => i.name.startsWith("Route 53 Resolver endpoint"));
  assert.deepEqual([r.gbp_h, r.qty, r.whole_hours], [0.0938, 4, true]);
});

test("ans-23's Resolver (ruling P12): two Do53 endpoints at fixed .10 and .11 addresses, one FORWARD rule for the corp .internal name to dnsmasq", () => {
  const { files, tf } = awsLab(ID);
  for (const re of [
    /direction\s+= "INBOUND"/, /direction\s+= "OUTBOUND"/, /inbound_ips\s+= \[for k in \[0, 1\] : cidrhost\(cidrsubnet\(local\.vpc_cidr, 4, k\), 10\)\]/,
    /outbound_ips\s+= \[for k in \[0, 1\] : cidrhost\(cidrsubnet\(local\.vpc_cidr, 4, k\), 11\)\]/, /rule_type\s+= "FORWARD"/, /domain_name\s+= local\.corp_domain/,
    /corp_domain\s+= "corp\.\$\{var\.name_prefix\}\.internal"/, /cloud_domain = "cloud\.\$\{var\.name_prefix\}\.internal"/, /resolver_endpoint_id = aws_route53_resolver_endpoint\.outbound\.id/,
    /dns_ip\s+= cidrhost\(local\.onprem_subnet_cidr, 10\)/,
  ]) assert.match(tf, re);
  assert.equal([...files["resolver.tf"].matchAll(/protocols\s+= \["Do53"\]/g)].length, 2);
  assert.equal([...tf.matchAll(/resource "aws_route53_resolver_rule" /g)].length, 1);
  assert.match(block("aws_route53_resolver_rule", "corp"), /ip\s+= local\.dns_ip\n\s+port = 53/);
  assert.doesNotMatch(tf, /"(SYSTEM|RECURSIVE)"/);
  assert.match(block("aws_instance", "cloud"), /depends_on\s+= \[aws_vpc_endpoint\.s3, aws_route53_resolver_endpoint\.inbound, aws_route53_resolver_endpoint\.outbound\]/, "vm-cloud never takes an endpoint's fixed address");
});

test("ans-23's dnsmasq: on its own address, answers the corp name, forwards the cloud name to the inbound endpoint", () => {
  const { files } = awsLab(ID);
  const c = files["compute.tf"];
  for (const s of ['"listen-address=${local.dns_ip}"', '"bind-interfaces"', '"no-resolv"', '"server=169.254.169.253"', '"local=/${local.corp_domain}/"', '"address=/app.${local.corp_domain}/${local.dns_ip}"', '"server=/${local.cloud_domain}/${local.inbound_ips[0]}"', '"server=/${local.cloud_domain}/${local.inbound_ips[1]}"', "dnf install -y dnsmasq bind-utils", "--conf-file=/etc/lab-dnsmasq.conf"]) assert.ok(c.includes(s), s);
  assert.match(block("aws_instance", "dns"), /private_ip\s+= local\.dns_ip/);
  assert.match(block("aws_ec2_instance_connect_endpoint", "onprem"), /depends_on\s+= \[aws_instance\.dns\]/);
});

test("ans-23's firewall, logs and waits (rulings P7, P8, P21): NXDOMAIN for example.com, logs to the lab's bucket for this account only, changes after 20 seconds", () => {
  const { tf } = awsLab(ID);
  for (const re of [/domains = \["example\.com\.", "\*\.example\.com\."\]/, /action\s+= "BLOCK"/, /block_response\s+= "NXDOMAIN"/, /mutation_protection\s+= "DISABLED"/, /destination_arn = aws_s3_bucket\.dnslogs\.arn/, /Principal = \{ Service = "delivery\.logs\.amazonaws\.com" \}/, /create_duration = "20s"/]) assert.match(tf, re);
  assert.equal([...block("aws_s3_bucket_policy", "dnslogs").matchAll(/"aws:SourceAccount" = data\.aws_caller_identity\.current\.account_id/g)].length, 2);
  for (const t of ["aws_route53_resolver_rule_association", "aws_route53_resolver_firewall_rule", "aws_route53_resolver_query_log_config_association"]) assert.match(block(t), /depends_on\s+= \[time_sleep\.resolver_tags\]/, t);
  for (const r of ["aws_route53_resolver_rule.corp", "aws_route53_resolver_firewall_domain_list.blocked", "aws_route53_resolver_firewall_rule_group.lab", "aws_route53_resolver_query_log_config.lab"]) assert.ok(block("time_sleep", "resolver_tags").includes(r), r);
  assert.doesNotMatch(tf, /aws_cloudwatch_log_group|cloud-watch-logs|arn:aws:logs:/, "ruling P8: no CloudWatch Logs destination");
});

test("ans-23's networks: the data centre in the slot's second /20, peered by the lab; a private .internal zone on vpc-lab", () => {
  const { tf } = awsLab(ID);
  for (const re of [/onprem_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/, /auto_accept = true/, /name\s+= local\.cloud_domain/, /vpc_id\s+= aws_vpc\.lab\.id\n\s+vpc_region = var\.region/, /records = \[aws_instance\.cloud\.private_ip\]/]) assert.match(tf, re);
  assert.equal([...tf.matchAll(/resource "aws_ec2_instance_connect_endpoint"/g)].length, 2);
});

test("ans-23's readme walks both directions, the firewall and the logs; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["rslvr-in", "rslvr-out", "dnsmasq", "NXDOMAIN", "vpcdnsquerylogs", "journalctl -u lab-dns"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-ans-23.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged from `labs/_template-aws/`; `variables.tf` is the template's header and its seven blocks named under Files, verbatim. Run `terraform fmt -check -recursive labs/ans-23-hybrid-dns/terraform` (where terraform is installed; else `npm run labs-tf -- ans-23-hybrid-dns` in Step 6 formats-checks it) and commit the formatted text.

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/ans-23-hybrid-dns.mjs` (saa-15's and soa-08's form: `ctxAws("ans-23-hybrid-dns", "23")`, `providers: ["aws"]`, `providerConfig: AWS_PROVIDER_CONFIG`, `data: awsData()`, and `doc()` printing policies with sorted keys as saa-15's does). With `onprem = cidrsubnet(c.address, 2, 1)`, `onpremSub = cidrsubnet(onprem, 4, 0)`, `dnsIp` = its host 10, `inIps`/`outIps` = host 10 / 11 of `cidrsubnet(c.vpcCidr, 4, 0)` and `(…, 4, 1)`, `corp = "corp.a23k3x9q.internal"`, `cloud = "cloud.a23k3x9q.internal"`, the resources, in file order after `...templateResources(c)`:
  - **onprem.tf**: `aws_vpc.onprem` (known `cidr_block: onprem`, DNS flags, Name; refs `cidr_block: ["local.onprem_cidr"]`); `aws_subnet.onprem` (known cidr, `availability_zone: "eu-west-2a"`, `map_public_ip_on_launch: false`; unknown `vpc_id` → `aws_vpc.onprem`; refs `cidr_block: ["local.onprem_subnet_cidr"]`, `availability_zone: ["local.azs[0]", "local.azs"]`); `aws_route_table.onprem`, `aws_route_table_association.onprem`, `aws_vpc_endpoint.onprem_s3` (known `service_name: com.amazonaws.eu-west-2.s3`, Gateway; unknown `vpc_id`, `route_table_ids`) (the table and association: unknown `vpc_id`, `subnet_id`, `route_table_id` by reference; the endpoint: refs `service_name: ["var.region"]`); `aws_vpc_peering_connection.cloud_onprem` (known `auto_accept: true`; unknown `vpc_id` → `aws_vpc.lab`, `peer_vpc_id` → `aws_vpc.onprem`); `aws_route.cloud_to_onprem` (known `destination_cidr_block: onprem`; unknown `route_table_id` → `aws_route_table.private`, `vpc_peering_connection_id` → the peering) and `aws_route.onprem_to_cloud` (known `c.vpcCidr`, refs `local.vpc_cidr`; unknown `route_table_id` → `aws_route_table.onprem`); `aws_security_group.eice_onprem` and its egress rule (known `cidr_ipv4: onprem`); `aws_ec2_instance_connect_endpoint.onprem` (unknown `subnet_id`, `security_group_ids.0`).
  - **resolver.tf**: `aws_security_group.resolver` (unknown `vpc_id` → `aws_vpc.lab`); its two ingress rules (known `cidr_ipv4: onprem`, udp/tcp 53) and two egress rules (known `cidr_ipv4: \`${dnsIp}/32\``, refs `["local.dns_ip"]`); `aws_route53_resolver_endpoint.inbound` and `.outbound` (known `name` `lab-ans-23-hybrid-dns-in`/`-out`, `direction`, `protocols: ["Do53"]`, `ip_address: [{ ip: inIps[0] }, { ip: inIps[1] }]` (outbound: `outIps`), Name tag; unknown `security_group_ids`, `ip_address.0.subnet_id`, `ip_address.1.subnet_id`; refs `security_group_ids` → `aws_security_group.resolver`, `ip_address.0.subnet_id: ["aws_subnet.private[0].id", "aws_subnet.private[0]", "aws_subnet.private"]`, `ip_address.1.subnet_id` likewise `[1]`, `ip_address.0.ip: ["local.inbound_ips[0]", "local.inbound_ips"]`); `aws_route53_resolver_rule.corp` (known `name`, `rule_type: "FORWARD"`, `domain_name: corp`, `target_ip: [{ ip: dnsIp, port: 53 }]`; unknown `resolver_endpoint_id` → `aws_route53_resolver_endpoint.outbound`; refs `domain_name: ["local.corp_domain"]`, `target_ip.0.ip: ["local.dns_ip"]`); `time_sleep.resolver_tags` (known `create_duration: "20s"`, no refs); `aws_route53_resolver_rule_association.corp` (known `name`; unknown `resolver_rule_id` → the rule, `vpc_id` → `aws_vpc.lab`); `aws_route53_zone.cloud` (known `name: cloud`, `force_destroy: true`, `vpc: [{ vpc_region: "eu-west-2" }]`; unknown `vpc.0.vpc_id` → `aws_vpc.lab`); `aws_route53_record.app` (known `name: "app." + cloud`, `type: "A"`, `ttl: 60`; unknown `zone_id` → the zone's `zone_id`, `records` → `aws_instance.cloud.private_ip`).
  - **dnsfw.tf**: `aws_route53_resolver_firewall_domain_list.blocked` (known name and `domains`); `aws_route53_resolver_firewall_rule_group.lab` (known name); `aws_route53_resolver_firewall_rule.block` (known `name`, `action`, `block_response`, `priority: 100`; unknown `firewall_domain_list_id`, `firewall_rule_group_id` by reference); `aws_route53_resolver_firewall_rule_group_association.lab` (known `name`, `priority: 101`, `mutation_protection: "DISABLED"`; unknown `firewall_rule_group_id`, `vpc_id` by reference).
  - **querylog.tf**: `aws_s3_bucket.dnslogs` (known `bucket: "cloudlabs-a23k3x9q-dnslogs"`, `force_destroy: true`; refs `bucket: ["local.dnslogs_bucket"]`); its public access block (unknown `bucket` → the bucket's `id`); `aws_s3_bucket_policy.dnslogs` (known `policy: doc([...])`, the two statements with `ACCOUNT` in the resource and both `aws:SourceAccount` conditions; unknown `bucket`; refs `policy: ["local.dnslogs_arn", ...ref("data.aws_caller_identity.current", "account_id")]`); `aws_route53_resolver_query_log_config.lab` (known `name`; unknown `destination_arn` → `aws_s3_bucket.dnslogs.arn`); `aws_route53_resolver_query_log_config_association.lab` (unknown `resolver_query_log_config_id` → the config, `resource_id` → `aws_vpc.lab`).
  - **compute.tf**: `aws_security_group.cloud` and `.dns` (unknown `vpc_id`) with their rules (known CIDRs: `onprem`, `GATEWAY_CIDR` with refs `["var.gateway_cidr"]`, `c.address` with refs `["var.address_space"]`, `0.0.0.0/0`; unknown `security_group_id`, and `referenced_security_group_id` → `aws_security_group.eice` / `.eice_onprem`); `al2023Instance(c, { key: "cloud", name: "vm-cloud", type: "t4g.nano", sgs: ["aws_security_group.cloud"] })` with `refs.user_data = ["local.cloud_cloud_init"]`; `al2023Instance(c, { key: "dns", name: "vm-dns", type: "t4g.nano", subnet: "aws_subnet.onprem", sgs: ["aws_security_group.dns"] })` with `values.private_ip = dnsIp`, `refs.private_ip = ["local.dns_ip"]`, `refs.user_data = ["local.dns_cloud_init"]` (both cloud-inits are built from known locals: known at plan, sensitive for the session password).

  `node --test scripts/test/lab-plans.test.mjs` proves it passes the scope check (Task 4's Resolver cases included) and the shape checks.

- [ ] **Step 5: Generate the planned graph and the readme diagram** (`npm run labs-topology -- ans-23-hybrid-dns`, `npm run labs-diagrams -- ans-23-hybrid-dns`); read the generated graph against "The diagram" list above (a difference is a Task 10 rule to fix test-first, never a GOLDEN edit to match a wrong graph); add `GOLDEN["ans-23-hybrid-dns"]` (the graph's nodes as `kind label < parent` lines and its edges) to `worker/test/topology-golden.test.ts`, and `"ans-23-hybrid-dns"` to `AWS_LAB_IDS` in `worker/test/fixtures/topology/round-trip.ts`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-23.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-23-hybrid-dns`, `npm run labs-topology -- --check ans-23-hybrid-dns`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/ans-23-hybrid-dns labs/_learning/ans-23-hybrid-dns.yaml shared/topology/planned/ans-23-hybrid-dns.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-23 hybrid DNS with Route 53 Resolver, DNS Firewall and query logs

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 15: Lab ans-24-privatelink

Spec: §12.2 row 24 (design, implementation, security, saa.secure; expert; explore; £ 0.05; peering optional; 6/6; 2/4; prerequisite 20; provider VPC with NLB and endpoint service, consumer VPC with interface endpoint and private DNS, gateway endpoint with policy); §4; §7.4; rulings A11, A45, A68, A87, A88, A100, P1, P7, P13, P23. Design sheet: Lab 24.

**Files:**
- Create: `labs/ans-24-privatelink/lab.yaml`, `readme.md`
- Create: `labs/ans-24-privatelink/terraform/versions.tf`, `main.tf`, `network.tf` (all three copied unchanged from `labs/_template-aws/`), `variables.tf` (the template's header and its `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password` and `tags` blocks, verbatim), `provider-vpc.tf`, `service.tf`, `consumer.tf`, `iam.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/ans-24-privatelink.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-24-privatelink.mjs`
- Create (generated): `shared/topology/planned/ans-24-privatelink.json`, `shared/guides/ans-24-privatelink/**`
- Modify: `shared/guides/{index,placement}.json` (generated), `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-ans-24.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`AWS_DNS_LABS` holds `ans-24-privatelink`: the private zone is listed and cleaned up in us-east-1); Task 2 (`ec2:CreateVpcEndpointServiceConfiguration` create-listed with its tags); Task 3 (`aws_vpc_endpoint_service`, `aws_lb_target_group_attachment` on `AWS_TYPES`); Task 4 (`batch4Problems`: the endpoint service's principals only this account's root, no private DNS name, its load balancer by reference; the interface endpoint's `service_name` the lab's own service by reference; the target attachment's group and instance by reference); Task 6 (`del_vpce_svc`: the service's connected endpoints, then the service, before load balancers; the ready check's existing `ec2:vpc-endpoint` and load balancer cases); Task 10 (`privateLinkService` with a `fronts` edge to its NLB). Batch 3's `aws_vpc_endpoint_policy` rule (A100, `endpointPolicyProblem`) holds the gateway endpoint's policy.

**`labs/ans-24-privatelink/lab.yaml`**
```yaml
# Lab ans-24 (AWS labs batch 4). ANS-C01 ((V) the wording against the current
# exam guide): Network Design (private connectivity to services across VPCs);
# Network Implementation (PrivateLink endpoint services and interface
# endpoints, private DNS); Network Security, Compliance, and Governance
# (endpoint policies); and SAA-C03's Design Secure Architectures.
# London list prices × 0.75 (labs-verify --aws-prices); the NLB and the
# interface endpoint bill each started hour whole (V, A20). NLB capacity
# units, the private zone (a month's fee; spec §15, V) and data through the
# endpoint are authored.
id: ans-24-privatelink
version: 1
cloud: aws
title: "PrivateLink: endpoints and endpoint services"
summary: >-
  A provider VPC publishes a web service behind an internal Network Load Balancer as a PrivateLink endpoint service;
  a consumer VPC reaches it through an interface endpoint and a private DNS name, with no peering and no routes
  between them, and reads S3 through a gateway endpoint whose policy allows only the lab's bucket.
exam: ANS-C01
skill_areas: [ans.design, ans.implementation, ans.security, saa.secure]
level: expert
type: explore
prerequisites: [ans-20-vpc-design]
cost:
  items:
    - name: "Network Load Balancer, hourly"
      gbp_h: 0.0198
      whole_hours: true
      aws_price: { service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Network", usagetype: "{usage}-LoadBalancerUsage" } }
    - { name: "NLB capacity units, light test traffic", gbp_h: 0.0045 }
    - name: "Interface endpoint, one Availability Zone"
      gbp_h: 0.0083
      whole_hours: true
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { productFamily: VpcEndpoint, usagetype: "{usage}-VpcEndpoint-Hours" } }
    - name: "EC2 t4g.nano, Linux (vm-consumer and vm-provider)"
      gbp_h: 0.0035
      qty: 2
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 2
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "Route 53 private hosted zone ($0.50 a month)", gbp_h: 0.0005 }
    - { name: "EC2 Instance Connect Endpoints (2) and the S3 gateway endpoints", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 4 }
capacity: { instance_types: [t4g.nano, t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 2 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`labs/ans-24-privatelink/terraform/provider-vpc.tf`**
```hcl
# provider-vpc.tf
#
# Plain English: lab 24's provider side, vpc-provider (the slot's second
# /20), the VPC of a team that publishes a service. Two private subnets in
# two Availability Zones for its load balancer, a route table with no route
# to the consumer at all (PrivateLink needs none), a free S3 gateway
# endpoint, and its own Instance Connect Endpoint for console SSH to
# vm-provider.

locals {
  provider_cidr = cidrsubnet(var.address_space, 2, 1)
}

resource "aws_vpc" "provider" {
  cidr_block           = local.provider_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-provider" }
}

resource "aws_subnet" "provider" {
  count                   = 2
  vpc_id                  = aws_vpc.provider.id
  cidr_block              = cidrsubnet(local.provider_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-provider-${count.index + 1}" }
}

resource "aws_route_table" "provider" {
  vpc_id = aws_vpc.provider.id
  tags   = { Name = "rt-provider" }
}

resource "aws_route_table_association" "provider" {
  count          = 2
  subnet_id      = aws_subnet.provider[count.index].id
  route_table_id = aws_route_table.provider.id
}

resource "aws_vpc_endpoint" "provider_s3" {
  vpc_id            = aws_vpc.provider.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.provider.id]
  tags              = { Name = "vpce-s3-provider" }
}

resource "aws_security_group" "eice_provider" {
  name        = "lab-eice-provider"
  description = "Instance Connect Endpoint in vpc-provider: SSH out to vm-provider"
  vpc_id      = aws_vpc.provider.id
  tags        = { Name = "sg-eice-provider" }
}

resource "aws_vpc_security_group_egress_rule" "eice_provider_ssh" {
  security_group_id = aws_security_group.eice_provider.id
  cidr_ipv4         = local.provider_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "provider" {
  subnet_id          = aws_subnet.provider[0].id
  security_group_ids = [aws_security_group.eice_provider.id]
  preserve_client_ip = false
  tags               = { Name = "eice-provider" }
}
```

**`labs/ans-24-privatelink/terraform/service.tf`**
```hcl
# service.tf
#
# Plain English: lab 24's endpoint service (ruling P13). vm-provider's page
# sits behind an internal Network Load Balancer, nlb-<name_prefix>, in both
# provider subnets, TCP 80, with client IP preservation off (vm-provider sees
# the load balancer's own address, which its security group admits). The
# endpoint service vpces-lab publishes the load balancer: only this
# account's root may connect, connections are accepted at once, and there is
# no private DNS name (that would need a public domain's TXT record), so the
# consumer names it in its own private zone instead.

resource "aws_lb" "provider" {
  name                       = "nlb-${var.name_prefix}"
  internal                   = true
  load_balancer_type         = "network"
  subnets                    = aws_subnet.provider[*].id
  enable_deletion_protection = false
  tags                       = { Name = "nlb-provider" }
}

resource "aws_lb_target_group" "provider" {
  name               = "tg-${var.name_prefix}"
  port               = 80
  protocol           = "TCP"
  vpc_id             = aws_vpc.provider.id
  target_type        = "instance"
  preserve_client_ip = "false"
  health_check {
    protocol            = "TCP"
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
  tags = { Name = "tg-provider" }
}

resource "aws_lb_target_group_attachment" "provider" {
  target_group_arn = aws_lb_target_group.provider.arn
  target_id        = aws_instance.provider.id
  port             = 80
}

resource "aws_lb_listener" "provider" {
  load_balancer_arn = aws_lb.provider.arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.provider.arn
  }
  tags = { Name = "listener-tcp-80" }
}

resource "aws_vpc_endpoint_service" "lab" {
  acceptance_required        = false
  network_load_balancer_arns = [aws_lb.provider.arn]
  allowed_principals         = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
  tags                       = { Name = "vpces-lab" }
}
```

**`labs/ans-24-privatelink/terraform/consumer.tf`**
```hcl
# consumer.tf
#
# Plain English: lab 24's consumer side, in the template's vpc-lab. An
# interface endpoint, vpce-svc, to the lab's own endpoint service (ruling
# P13), in snet-private-1 only (one Availability Zone, one hourly charge),
# admitting HTTP from vpc-lab. Its "private DNS" is a private hosted zone,
# svc.<name_prefix>.internal (ruling A88), with app as an alias of the
# endpoint's own name. And S3 through the template's gateway endpoint, now
# with a policy (ruling A100): through it only the lab's bucket,
# cloudlabs-<name_prefix>-data (one object, hello.txt), and Amazon Linux's
# package repositories can be reached.

locals {
  data_bucket = "cloudlabs-${var.name_prefix}-data"
  data_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-data"
  svc_domain  = "svc.${var.name_prefix}.internal"
}

resource "aws_security_group" "endpoint" {
  name        = "lab-endpoint"
  description = "The interface endpoint: HTTP from vpc-lab"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-endpoint" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoint_http" {
  security_group_id = aws_security_group.endpoint.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_endpoint" "svc" {
  vpc_id              = aws_vpc.lab.id
  service_name        = aws_vpc_endpoint_service.lab.service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private[0].id]
  security_group_ids  = [aws_security_group.endpoint.id]
  private_dns_enabled = false
  tags                = { Name = "vpce-svc" }
}

resource "aws_route53_zone" "svc" {
  name          = local.svc_domain
  force_destroy = true

  vpc {
    vpc_id     = aws_vpc.lab.id
    vpc_region = var.region
  }
  tags = { Name = "zone-svc" }
}

resource "aws_route53_record" "app" {
  zone_id = aws_route53_zone.svc.zone_id
  name    = "app.${local.svc_domain}"
  type    = "A"

  alias {
    name                   = aws_vpc_endpoint.svc.dns_entry[0].dns_name
    zone_id                = aws_vpc_endpoint.svc.dns_entry[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_vpc_endpoint_policy" "s3" {
  vpc_endpoint_id = aws_vpc_endpoint.s3.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabBucketOnly", Effect = "Allow", Principal = "*", Action = "s3:*", Resource = [local.data_arn, "${local.data_arn}/*"] },
      { Sid = "AmazonLinuxRepositories", Effect = "Allow", Principal = "*", Action = "s3:GetObject", Resource = "arn:aws:s3:::al2023-repos-${var.region}-*/*" },
    ]
  })
}

resource "aws_s3_bucket" "data" {
  bucket        = local.data_bucket
  force_destroy = true
  tags          = { Name = "data" }
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "hello" {
  bucket       = aws_s3_bucket.data.id
  key          = "hello.txt"
  content      = "read through the S3 gateway endpoint, whose policy allows only this bucket\n"
  content_type = "text/plain"
}
```

**`labs/ans-24-privatelink/terraform/iam.tf`**
```hcl
# iam.tf
#
# Plain English: lab 24's consumer role, lab-<id>-consumer, under the lab
# boundary: vm-consumer may list and read the lab's bucket and nothing else
# in S3. The policy names the bucket by its built ARN, so it is known at plan
# (ruling A42).

resource "aws_iam_role" "consumer" {
  name                 = "lab-${var.lab_id}-consumer"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "s3_read" {
  name = "lab-${var.lab_id}-s3-read"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabBucketList", Effect = "Allow", Action = "s3:ListBucket", Resource = local.data_arn },
      { Sid = "LabBucketRead", Effect = "Allow", Action = "s3:GetObject", Resource = "${local.data_arn}/*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "consumer" {
  role       = aws_iam_role.consumer.name
  policy_arn = aws_iam_policy.s3_read.arn
}

resource "aws_iam_instance_profile" "consumer" {
  name = "lab-${var.lab_id}-consumer"
  path = "/cloudlabs-lab/"
  role = aws_iam_role.consumer.name
}
```

**`labs/ans-24-privatelink/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 24's two instances (t4g.nano, Amazon Linux 2023), each
# serving a page naming itself (lab-web.service, python3 on port 80).
# vm-consumer in vpc-lab runs as the consumer role; vm-provider in
# vpc-provider is the endpoint service's only target and admits HTTP from
# its own VPC, where the load balancer's addresses are. Each admits SSH from
# its VPC's Instance Connect Endpoint and, once peered, SSH and HTTP from the
# VPN server's VPC (ruling A45).

locals {
  pages = {
    consumer = "vm-consumer in vpc-lab, the consumer"
    provider = "vm-provider in vpc-provider, reached through PrivateLink"
  }
  web_units = { for k, text in local.pages : k => join("\n", [
    "[Unit]",
    "Description=Lab 24 page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"${text}\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ]) }
  web_cloud_init = { for k, unit in local.web_units : k => "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}" }
}

resource "aws_security_group" "consumer" {
  name        = "lab-consumer"
  description = "vm-consumer: SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-consumer" }
}

resource "aws_vpc_security_group_ingress_rule" "consumer_ssh_eice" {
  security_group_id            = aws_security_group.consumer.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "consumer_ssh_gateway" {
  security_group_id = aws_security_group.consumer.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "consumer_http_gateway" {
  security_group_id = aws_security_group.consumer.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "consumer_all" {
  security_group_id = aws_security_group.consumer.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "provider" {
  name        = "lab-provider"
  description = "vm-provider: HTTP from vpc-provider (the load balancer), SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.provider.id
  tags        = { Name = "sg-provider" }
}

resource "aws_vpc_security_group_ingress_rule" "provider_http" {
  security_group_id = aws_security_group.provider.id
  cidr_ipv4         = local.provider_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "provider_ssh_eice" {
  security_group_id            = aws_security_group.provider.id
  referenced_security_group_id = aws_security_group.eice_provider.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "provider_ssh_gateway" {
  security_group_id = aws_security_group.provider.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "provider_http_gateway" {
  security_group_id = aws_security_group.provider.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "provider_all" {
  security_group_id = aws_security_group.provider.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "consumer" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.consumer.id]
  iam_instance_profile   = aws_iam_instance_profile.consumer.name
  user_data              = local.web_cloud_init["consumer"]

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-consumer" })
  tags        = { Name = "vm-consumer" }
  depends_on  = [aws_iam_role_policy_attachment.consumer, aws_vpc_endpoint_policy.s3]
}

resource "aws_instance" "provider" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.provider[0].id
  vpc_security_group_ids = [aws_security_group.provider.id]
  user_data              = local.web_cloud_init["provider"]

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-provider" })
  tags        = { Name = "vm-provider" }
  depends_on  = [aws_vpc_endpoint.provider_s3, aws_route_table_association.provider]
}
```

**`labs/ans-24-privatelink/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 24 is up: the two
# instances, how to connect to each, the service by its private name and by
# the endpoint's own name, the S3 read through the gateway endpoint, and,
# while peered, SSH and the page on vm-consumer. vpc-lab is the hub.

output "private_ips" {
  value = { "vm-consumer" = aws_instance.consumer.private_ip, "vm-provider" = aws_instance.provider.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.consumer.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.provider.id} --os-user labadmin --connection-type eice",
    "From vm-consumer: curl http://app.${local.svc_domain}",
    "From vm-consumer: curl http://${aws_vpc_endpoint.svc.dns_entry[0].dns_name}",
    "From vm-consumer: aws s3 cp s3://${local.data_bucket}/hello.txt - --region ${var.region}",
    "ssh labadmin@${aws_instance.consumer.private_ip}",
    "curl http://${aws_instance.consumer.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/ans-24-privatelink/readme.md`** (exactly):
````markdown
PrivateLink lets one VPC offer a service to another without joining their networks: no peering, no routes, overlapping address ranges allowed, and the consumer can reach only the one service, never the rest of the provider's VPC. This lab builds both sides in one account: a provider VPC that publishes a web page behind a Network Load Balancer as an endpoint service, and a consumer VPC that reaches it through an interface endpoint under a private DNS name of its own. It also puts a policy on the consumer's S3 gateway endpoint, the other kind of VPC endpoint. Everything is listed in the lab's resource group, `lab-ans-24-privatelink`, in AWS Resource Groups (London); the private hosted zone is a global Route 53 item, under Route 53 in the console.
From the ANS-C01 outline: design and implement private connectivity to services with AWS PrivateLink (endpoint services, interface and gateway endpoints), their DNS, and endpoint policies.

## What it deploys

- **Provider**: the VPC `vpc-provider` (the slot's second /20) with `vm-provider` (t4g.nano, a page naming itself) behind the internal Network Load Balancer `nlb-<name prefix>` (Name `nlb-provider`, TCP 80 in both provider subnets), and the endpoint service `vpces-lab` that publishes it: only this account may connect, and connections are accepted without a request
- **Consumer**: the interface endpoint `vpce-svc` in `vpc-lab`'s first subnet, and the private hosted zone `svc.<name prefix>.internal`, whose name `app` points at the endpoint, so `vm-consumer` reaches the service as `app.svc.<name prefix>.internal`
- **S3**: the template's gateway endpoint `vpce-s3` with a policy allowing only the lab's bucket `cloudlabs-<name prefix>-data` (one object, `hello.txt`) and Amazon Linux's package repositories, and the role `lab-ans-24-privatelink-consumer`, which lets `vm-consumer` read that bucket
- No peering and no route between `vpc-lab` and `vpc-provider`

```text
lab-ans-24-privatelink (London)
  vm-consumer (vpc-lab) --app.svc.<prefix>.internal--> vpce-svc (snet-private-1) ==PrivateLink==> vpces-lab --> nlb-provider --> vm-provider (vpc-provider)
  vm-consumer --vpce-s3 (policy: lab bucket + AL2023 repos only)--> cloudlabs-<prefix>-data
  vpc-lab and vpc-provider: no peering, no routes
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Connect to `vm-consumer` (the first Connect line) and fetch the service by its private name (the third line), then by the endpoint's own name (the fourth). Both answer with vm-provider's page. `getent hosts app.svc.<name prefix>.internal` shows an address in `snet-private-1`: the endpoint's network interface, in the consumer's own subnet.
- Look at `rt-private` in the VPC console: it has no route to `vpc-provider`, and from `vm-consumer`, `curl http://<vm-provider address>` (from the dashboard's addresses) never answers. PrivateLink reaches the one service behind the load balancer and nothing else in the provider's VPC.
- Watch who the provider sees: connect to `vm-provider` (the second Connect line), run `sudo journalctl -u lab-web -f`, and fetch the page again from `vm-consumer`. Requests come from the load balancer's addresses in `vpc-provider`, never from the consumer: the provider cannot tell which VPC asked.
- In the VPC console, Endpoint services, `vpces-lab`: the Allow principals tab names only this account, and Endpoint connections lists `vpce-svc`, accepted without a request. Reject the connection there and fetch again: it times out, though the service, the load balancer and vm-provider are untouched. Tear the lab down and deploy it again to get a connected endpoint back.
- Read S3 through the gateway endpoint with the fifth Connect line: `hello.txt` comes back. Open `vpce-s3`'s Policy tab: even a role allowed every bucket could reach only the lab's bucket and Amazon Linux's repositories through this endpoint.

## Learn more

- [What is AWS PrivateLink?](https://docs.aws.amazon.com/vpc/latest/privatelink/what-is-privatelink.html)
- [Share your services through AWS PrivateLink](https://docs.aws.amazon.com/vpc/latest/privatelink/privatelink-share-your-services.html)
- [Access an AWS service using an interface VPC endpoint](https://docs.aws.amazon.com/vpc/latest/privatelink/create-interface-endpoint.html)
- [Gateway endpoints for Amazon S3](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html)
- [Control access to VPC endpoints using endpoint policies](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-access.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-24-privatelink` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-24-privatelink.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Publish a service with PrivateLink and reach it from another VPC by a private name, with no peering.
learn:
  - Publish a load-balanced service as a PrivateLink endpoint service
  - Reach it through an interface endpoint under a private DNS name
  - Limit an S3 gateway endpoint to one bucket with its policy
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-ans-24-privatelink · London`; `vnet vpc-lab` with `subnet snet-private-1/2`; `vnet vpc-provider` with `subnet snet-provider-1/2`; no edge between the two VPCs; `loadBalancer nlb-provider` with a `traffic` edge `TCP 80` to `vm vm-provider`; `privateLinkService vpces-lab` with a `dependency` edge `fronts` to `nlb-provider`; `privateEndpoint vpce-svc`, `vpce-s3`, `vpce-s3-provider`; `dnsZone zone-svc`; `storage data`; `managedIdentity lab-ans-24-privatelink-consumer`; `vm vm-consumer`; `routeTable rt-private`, `rt-provider`; `nsg sg-eice`, `sg-vms`, `sg-endpoint`, `sg-consumer`, `sg-eice-provider`, `sg-provider`; `bastion eice-lab`, `eice-provider`. The target group, its attachment, the listener, the record, the endpoint policy and the object fold into their parents.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-ans-24.test.mjs`:

```js
// labs-aws-ans-24.test.mjs
//
// Plain English: lab ans-24-privatelink is the lab AWS labs spec §12.2 row 24
// describes: a provider VPC with an NLB and an endpoint service, a consumer
// VPC with an interface endpoint and a private name, and a gateway endpoint
// with a policy (rulings A88, A100, P1, P13).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_DNS_LABS, AWS_GLOBAL_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "ans-24-privatelink";
const block = (type, name) => awsLab(ID).blocks.find((b) => b.kind === "resource" && b.labels[0] === type && (name === undefined || b.labels[1] === name))?.body ?? "";

test("ans-24 keeps the AWS lab contract and lists its private zone in us-east-1 (ruling P1)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.ok(AWS_DNS_LABS.includes(ID) && !AWS_GLOBAL_LABS.includes(ID));
});

test("ans-24's lab.yaml: §12.2 row 24, about £0.04/h, the NLB and the endpoint billed by the whole hour, one role", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.implementation", "ans.security", "saa.secure"], ["ans-20-vpc-design"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.identity, { creates: ["role"], roles: [], governance: false });
  assert.deepEqual(yaml.regions, { secondary: null });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.035 && total < 0.055, `about £0.04/h, got ${total}`);
  for (const n of ["Network Load Balancer, hourly", "Interface endpoint, one Availability Zone"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
});

test("ans-24's endpoint service (ruling P13): an internal NLB, this account's root only, accepted at once, no private DNS name", () => {
  const { tf } = awsLab(ID);
  for (const re of [/internal\s+= true/, /load_balancer_type\s+= "network"/, /preserve_client_ip = "false"/, /acceptance_required\s+= false/, /network_load_balancer_arns = \[aws_lb\.provider\.arn\]/, /allowed_principals\s+= \["arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:root"\]/, /target_id\s+= aws_instance\.provider\.id/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /private_dns_name|supported_regions|gateway_load_balancer_arns/);
});

test("ans-24's consumer: an interface endpoint to the lab's own service in one subnet, a private .internal alias to it, no route to the provider", () => {
  const { tf } = awsLab(ID);
  const e = block("aws_vpc_endpoint", "svc");
  for (const re of [/service_name\s+= aws_vpc_endpoint_service\.lab\.service_name/, /vpc_endpoint_type\s+= "Interface"/, /subnet_ids\s+= \[aws_subnet\.private\[0\]\.id\]/, /private_dns_enabled = false/]) assert.match(e, re);
  for (const re of [/svc_domain\s+= "svc\.\$\{var\.name_prefix\}\.internal"/, /name\s+= aws_vpc_endpoint\.svc\.dns_entry\[0\]\.dns_name/, /provider_cidr = cidrsubnet\(var\.address_space, 2, 1\)/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /aws_vpc_peering_connection|resource "aws_route" /, "PrivateLink needs no peering and no routes");
});

test("ans-24's S3 (ruling A100): the gateway endpoint's policy and the role reach only the lab's bucket", () => {
  const { tf } = awsLab(ID);
  for (const re of [/vpc_endpoint_id = aws_vpc_endpoint\.s3\.id/, /Resource = \[local\.data_arn, "\$\{local\.data_arn\}\/\*"\]/, /arn:aws:s3:::al2023-repos-\$\{var\.region\}-\*\/\*/, /Action = "s3:ListBucket", Resource = local\.data_arn/, /Action = "s3:GetObject", Resource = "\$\{local\.data_arn\}\/\*"/, /iam_instance_profile\s+= aws_iam_instance_profile\.consumer\.name/]) assert.match(tf, re);
});

test("ans-24's readme shows both names, the provider's view and the endpoint policy; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["vpces-lab", "vpce-svc", "app.svc.", "journalctl -u lab-web", "no peering", "hello.txt"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-ans-24.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; `variables.tf` is the template's header and its seven blocks named under Files, verbatim.

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/ans-24-privatelink.mjs` (saa-15's form, with its `doc()` helper). With `prov = cidrsubnet(c.address, 2, 1)`, `bucket = "cloudlabs-a24k3x9q-data"`, `svc = "svc.a24k3x9q.internal"`, the resources after `...templateResources(c)`, in file order:
  - **provider-vpc.tf**: `aws_vpc.provider` (known `cidr_block: prov`; refs `["local.provider_cidr"]`); `aws_subnet.provider[0]`/`[1]` (`count: 2`; known `cidrsubnet(prov, 4, i)`, `eu-west-2a`/`b`; unknown `vpc_id`; refs `vpc_id` → `aws_vpc.provider`, `cidr_block: ["local.provider_cidr", "count.index"]`, `availability_zone: ["local.azs", "count.index"]`, `tags: ["count.index"]`); `aws_route_table.provider`; `aws_route_table_association.provider[0]`/`[1]` (refs `subnet_id: ["aws_subnet.provider", "count.index"]`); `aws_vpc_endpoint.provider_s3`; `aws_security_group.eice_provider` and its egress rule (known `cidr_ipv4: prov`); `aws_ec2_instance_connect_endpoint.provider` (unknown `subnet_id` → `aws_subnet.provider[0]`, `security_group_ids.0`).
  - **service.tf**: `aws_lb.provider` (known `name: "nlb-a24k3x9q"`, `internal: true`, `load_balancer_type: "network"`, `enable_deletion_protection: false`, Name; unknown `subnets` → `aws_subnet.provider`; refs `name: ["var.name_prefix"]`); `aws_lb_target_group.provider` (known `name: "tg-a24k3x9q"`, `port: 80`, `protocol: "TCP"`, `target_type: "instance"`, `preserve_client_ip: "false"`, `health_check: [{ protocol: "TCP", interval: 10, healthy_threshold: 2, unhealthy_threshold: 2 }]`; unknown `vpc_id` → `aws_vpc.provider`); `aws_lb_target_group_attachment.provider` (known `port: 80`; unknown `target_group_arn` → the group's `arn`, `target_id` → `aws_instance.provider.id`); `aws_lb_listener.provider` (known `port: 80`, `protocol: "TCP"`, `default_action: [{ type: "forward" }]`; unknown `load_balancer_arn`, `default_action.0.target_group_arn` by reference); `aws_vpc_endpoint_service.lab` (known `acceptance_required: false`, `allowed_principals: [\`arn:aws:iam::${ACCOUNT}:root\`]`, Name; unknown `network_load_balancer_arns` → `aws_lb.provider.arn`; refs `allowed_principals: ref("data.aws_caller_identity.current", "account_id")`).
  - **consumer.tf**: `aws_security_group.endpoint` and its ingress rule (known `cidr_ipv4: c.vpcCidr`, refs `["local.vpc_cidr"]`); `aws_vpc_endpoint.svc` (known `vpc_endpoint_type: "Interface"`, `private_dns_enabled: false`, Name; unknown `vpc_id` → `aws_vpc.lab`, `service_name` → `aws_vpc_endpoint_service.lab.service_name`, `subnet_ids` → `aws_subnet.private[0]` (refs `["aws_subnet.private[0].id", "aws_subnet.private[0]", "aws_subnet.private"]`), `security_group_ids` → `aws_security_group.endpoint`); `aws_route53_zone.svc` (known `name: svc`, `force_destroy: true`, `vpc: [{ vpc_region: "eu-west-2" }]`; unknown `vpc.0.vpc_id` → `aws_vpc.lab`); `aws_route53_record.app` (known `name: "app." + svc`, `type: "A"`, `alias: [{ evaluate_target_health: false }]`; unknown `zone_id`, `alias.0.name` → `aws_vpc_endpoint.svc.dns_entry`, `alias.0.zone_id` → the same); `aws_vpc_endpoint_policy.s3` (known `policy: doc([...])` with the bucket's ARN and `arn:aws:s3:::al2023-repos-eu-west-2-*/*`; unknown `vpc_endpoint_id` → `aws_vpc_endpoint.s3`; refs `policy: ["local.data_arn", "var.region"]`); `aws_s3_bucket.data` (known `bucket`, `force_destroy: true`; refs `["local.data_bucket"]`); its public access block; `aws_s3_object.hello` (known `key`, `content`, `content_type`; unknown `bucket`).
  - **iam.tf**: `aws_iam_role.consumer` (known name `lab-ans-24-privatelink-consumer`, path, `permissions_boundary: BOUNDARY`, the ec2 trust `doc`); `aws_iam_policy.s3_read` (known name, path, `doc` with the two statements; refs `policy: ["local.data_arn"]`); `aws_iam_role_policy_attachment.consumer` (known `role`; unknown `policy_arn` by reference); `aws_iam_instance_profile.consumer` (known name, path, `role`; refs `role` → the role's `name`).
  - **compute.tf**: `aws_security_group.consumer`, `.provider` and their rules (known CIDRs `GATEWAY_CIDR`, `prov`, `0.0.0.0/0`; referenced groups unknown by reference); `al2023Instance(c, { key: "consumer", name: "vm-consumer", type: "t4g.nano", profile: "aws_iam_instance_profile.consumer", sgs: ["aws_security_group.consumer"] })` and `al2023Instance(c, { key: "provider", name: "vm-provider", type: "t4g.nano", subnet: "aws_subnet.provider[0]", sgs: ["aws_security_group.provider"] })`, each with `refs.user_data = ["local.web_cloud_init[\"consumer\"]", "local.web_cloud_init"]` (or `provider`): known at plan (built from known locals), sensitive.

  `node --test scripts/test/lab-plans.test.mjs` proves it passes the scope check (P13's endpoint service and endpoint cases, A100's endpoint policy, P7's absence of a service-principal Allow) and the shape checks.

- [ ] **Step 5: Generate the planned graph and the readme diagram** (`npm run labs-topology -- ans-24-privatelink`, `npm run labs-diagrams -- ans-24-privatelink`); read the graph against "The diagram" above (a difference is a Task 10 rule fixed test-first); add `GOLDEN["ans-24-privatelink"]` and `"ans-24-privatelink"` to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-24.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-24-privatelink`, `npm run labs-topology -- --check ans-24-privatelink`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/ans-24-privatelink labs/_learning/ans-24-privatelink.yaml shared/topology/planned/ans-24-privatelink.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-24 PrivateLink endpoint service, interface endpoint and a gateway endpoint policy

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 16: Lab ans-25-load-balancing

Spec: §12.2 row 25 (design, security; expert; explore; £ 0.13; peering optional; 10/8; 2/3; prerequisite 03; ALB rules and weighted target groups with an imported self-signed certificate, NLB with static EIPs, TLS and proxy protocol, GWLB with a GENEVE appliance, V build time); §4 (a NAT gateway where the lab needs general internet); §7.4 (internet-facing ALB and NLB; the appliance builds through the NAT gateway, no public address); rulings A20, A45, P13, P14.

**Files:**
- Create: `labs/ans-25-load-balancing/lab.yaml`, `readme.md`
- Create: `labs/ans-25-load-balancing/terraform/versions.tf`, `main.tf`, `network.tf` (all three copied unchanged from `labs/_template-aws/`), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`, each block exactly as the template writes it), `subnets.tf`, `certs.tf`, `alb.tf`, `nlb.tf`, `gwlb.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/ans-25-load-balancing.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-25-load-balancing.mjs`
- Create (generated): `shared/topology/planned/ans-25-load-balancing.json`, `shared/guides/ans-25-load-balancing/**`
- Modify: `worker/test/topology-golden.test.ts` (`GOLDEN["ans-25-load-balancing"]`), `worker/test/fixtures/topology/round-trip.ts` (`AWS_LAB_IDS`)
- Test: `scripts/test/labs-aws-ans-25.test.mjs`

**Interfaces:**
- Consumes: the template network (`aws_vpc.lab`, `aws_subnet.private`, `aws_route_table.private`, `aws_vpc_endpoint.s3`, `aws_security_group.eice`, `aws_security_group.vms`, `local.vpc_cidr`, `local.azs`, `local.cloud_init_base`, `local.cloud_init`, `data.aws_caller_identity.current`); Task 2 (`acm:ImportCertificate` with its tags, `ec2:CreateVpcEndpointServiceConfiguration`, `elasticloadbalancing` made ahead); Task 3 (`aws_acm_certificate`, the four `tls_*` types, `aws_vpc_endpoint_service`, `aws_lb_target_group_attachment`, `aws_lb_listener_rule` on `AWS_TYPES`, and in the regenerated `computed.json`); Task 4 (`batch4Problems`: an endpoint service's principals only this account's root, an endpoint's `service_name` the lab's own service by reference, an imported certificate's key and body the lab's own `tls` resources, attachments' targets the lab's own instances, a route's `vpc_endpoint_id` the lab's own endpoint); Task 6 (the endpoint service and its endpoint deleted before the load balancers; the certificate in phase 5; the ready check's `acm:certificate` ISSUED); Task 10 (`aws_vpc_endpoint_service` → `privateLinkService` with a `fronts` edge, `aws_acm_certificate` → `generic`, `tls_*` hidden, `aws_lb_listener_rule` folded into its listener).
- Produces: nothing other tasks call.

**`labs/ans-25-load-balancing/lab.yaml`**
```yaml
# Lab ans-25 (AWS labs batch 4). ANS-C01 ((V) the wording against the current
# exam guide): Network Design (choosing a load balancer: ALB listener rules
# and weighted target groups, NLB static addresses, TLS and proxy protocol,
# GWLB appliances behind an endpoint); Network Security, Compliance, and
# Governance (TLS termination with an imported certificate, inline
# inspection of a subnet's internet traffic).
# London list prices × 0.75 (labs-verify --aws-prices); the three load
# balancers, the GWLB endpoint and the NAT gateway bill each started hour
# whole (V, A20). The NLB, GWLB and GWLB endpoint filters are (V, Task 23):
# if labs-verify finds no single product the item becomes authored-only.
# Capacity units are authored for light test traffic; ACM charges nothing for
# an imported certificate. The appliance is a t4g.small (ruling P14): it
# compiles AWS's tunnel handler at boot.
id: ans-25-load-balancing
version: 1
cloud: aws
title: "Load balancing in depth: ALB, NLB and GWLB"
summary: >-
  All three Elastic Load Balancing types in one VPC: an ALB with an HTTP redirect, an imported certificate, weighted
  blue and green target groups and a path rule; an NLB on a static Elastic IP with TLS and proxy protocol; and a
  Gateway Load Balancer sending one subnet's internet traffic through a GENEVE appliance.
exam: ANS-C01
skill_areas: [ans.design, ans.security]
level: expert
type: explore
prerequisites: [soa-03-auto-scaling]
cost:
  items:
    - name: "Application Load Balancer, hourly"
      gbp_h: 0.0199
      whole_hours: true
      aws_price: { service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Application", usagetype: "{usage}-LoadBalancerUsage" } }
    - { name: "ALB capacity units, light test traffic", gbp_h: 0.0060 }
    - name: "Network Load Balancer, hourly"
      gbp_h: 0.0198
      whole_hours: true
      aws_price: { service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Network", usagetype: "{usage}-LoadBalancerUsage" } }
    - { name: "NLB capacity units, light test traffic", gbp_h: 0.0045 }
    - name: "Gateway Load Balancer, hourly"
      gbp_h: 0.0103
      whole_hours: true
      aws_price: { service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Gateway", usagetype: "{usage}-LoadBalancerUsage" } }
    - name: "Gateway Load Balancer endpoint, one AZ"
      gbp_h: 0.0075
      whole_hours: true
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { usagetype: "{usage}-VpcEndpoint-GWLBE-Hours" } }
    - name: "NAT gateway, hourly"
      gbp_h: 0.0375
      whole_hours: true
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { productFamily: "NAT Gateway", usagetype: "{usage}-NatGateway-Hours" } }
    - name: "Public IPv4 addresses (the ALB's 2, the NAT gateway's, the NLB's Elastic IP)"
      gbp_h: 0.0038
      qty: 4
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - name: "EC2 t4g.small, Linux (the appliance)"
      gbp_h: 0.0141
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.small, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EC2 t4g.nano, Linux (blue, green and the client)"
      gbp_h: 0.0035
      qty: 3
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 4
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "ACM imported certificate", gbp_h: 0 }
    - { name: "EC2 Instance Connect Endpoint", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 10, destroy_min: 8, session_h: 2, max_h: 3 }
capacity: { instance_types: [t4g.small, t4g.nano, t4g.nano, t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/ans-25-load-balancing/terraform/subnets.tf`**
```hcl
# subnets.tf
#
# Plain English: lab 25's subnets, all in the template's vpc-lab (the slot's
# first /20). Two public subnets (the slot's /24s 2 and 3, one per zone) for
# the ALB, the NLB and the NAT gateway; and, in the first zone, a subnet for
# the appliance behind the Gateway Load Balancer (/24 4), one for the GWLB
# endpoint (/24 5) and one for the client whose internet traffic it inspects
# (/24 6). The routes make the inspection path: the client's default route is
# the GWLB endpoint; what the appliance sends back leaves through the NAT
# gateway; and the public route table sends replies for the client's /24 back
# through the endpoint, so both directions pass the appliance. The appliance
# reaches the internet (to build its software) through the NAT gateway.

locals {
  public_cidrs   = [cidrsubnet(local.vpc_cidr, 4, 2), cidrsubnet(local.vpc_cidr, 4, 3)]
  appliance_cidr = cidrsubnet(local.vpc_cidr, 4, 4)
  gwlbe_cidr     = cidrsubnet(local.vpc_cidr, 4, 5)
  inspected_cidr = cidrsubnet(local.vpc_cidr, 4, 6)
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-public-${count.index + 1}" }
}

resource "aws_subnet" "appliance" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.appliance_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-appliance" }
}

resource "aws_subnet" "gwlbe" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.gwlbe_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-gwlbe" }
}

resource "aws_subnet" "inspected" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = local.inspected_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-inspected" }
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "igw-lab" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat" }
}

# The NLB's static address (ruling P14): a subnet mapping, never on an instance.
resource "aws_eip" "nlb" {
  domain = "vpc"
  tags   = { Name = "eip-nlb" }
}

resource "aws_nat_gateway" "lab" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "nat-lab" }
  depends_on    = [aws_internet_gateway.lab, aws_route.public_internet]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-public" }
}

resource "aws_route_table" "appliance" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-appliance" }
}

resource "aws_route_table" "gwlbe" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-gwlbe" }
}

resource "aws_route_table" "inspected" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-inspected" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.lab.id
}

# Replies from the internet to the client come back through the appliance (more specific than the VPC's local route).
resource "aws_route" "public_inspected" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = local.inspected_cidr
  vpc_endpoint_id        = aws_vpc_endpoint.gwlb.id
}

resource "aws_route" "appliance_nat" {
  route_table_id         = aws_route_table.appliance.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.lab.id
}

resource "aws_route" "gwlbe_nat" {
  route_table_id         = aws_route_table.gwlbe.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.lab.id
}

resource "aws_route" "inspected_gwlbe" {
  route_table_id         = aws_route_table.inspected.id
  destination_cidr_block = "0.0.0.0/0"
  vpc_endpoint_id        = aws_vpc_endpoint.gwlb.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "appliance" {
  subnet_id      = aws_subnet.appliance.id
  route_table_id = aws_route_table.appliance.id
}

resource "aws_route_table_association" "gwlbe" {
  subnet_id      = aws_subnet.gwlbe.id
  route_table_id = aws_route_table.gwlbe.id
}

resource "aws_route_table_association" "inspected" {
  subnet_id      = aws_subnet.inspected.id
  route_table_id = aws_route_table.inspected.id
}
```

**`labs/ans-25-load-balancing/terraform/certs.tf`**
```hcl
# certs.tf
#
# Plain English: lab 25's certificate, made in the lab's own state and
# imported to ACM (ruling P14: import only, never requested from a CA). A
# self-signed CA, "cloudlabs ans-25 CA", signs a server certificate for
# app.<name_prefix>.internal (RSA 2048, both valid a week). The ALB's HTTPS
# listener and the NLB's TLS listener both use the one imported certificate.
# Browsers and curl do not trust it, which is the point: curl -k, or read the
# chain with openssl. The keys live only in the lab's R2 state.

resource "tls_private_key" "ca" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_private_key" "server" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem       = tls_private_key.ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 168
  allowed_uses          = ["cert_signing", "crl_signing"]

  subject {
    common_name  = "cloudlabs ans-25 CA"
    organization = "cloudlabs"
  }
}

resource "tls_cert_request" "server" {
  private_key_pem = tls_private_key.server.private_key_pem
  dns_names       = ["app.${var.name_prefix}.internal"]

  subject {
    common_name  = "app.${var.name_prefix}.internal"
    organization = "cloudlabs"
  }
}

resource "tls_locally_signed_cert" "server" {
  cert_request_pem      = tls_cert_request.server.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = 168
  allowed_uses          = ["server_auth", "digital_signature", "key_encipherment"]
}

resource "aws_acm_certificate" "app" {
  private_key       = tls_private_key.server.private_key_pem
  certificate_body  = tls_locally_signed_cert.server.cert_pem
  certificate_chain = tls_self_signed_cert.ca.cert_pem
  tags              = { Name = "cert-app" }
}
```

**`labs/ans-25-load-balancing/terraform/alb.tf`**
```hcl
# alb.tf
#
# Plain English: lab 25's internet-facing Application Load Balancer, in both
# public subnets. HTTP on port 80 only redirects to HTTPS. HTTPS on port 443
# ends TLS with the imported certificate and forwards by weight: 80 in 100
# requests to the blue target group (vm-blue), 20 to green (vm-green); a
# listener rule sends every path under /green/ to green alone. The web
# instances admit port 80 only from the load balancers' security groups.

resource "aws_security_group" "alb" {
  name        = "lab-alb"
  description = "The ALB: HTTP and HTTPS from the internet, HTTP on to the web instances"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_lb" "alb" {
  name                       = "alb-${var.name_prefix}"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = false
  tags                       = { Name = "alb-app" }

  # Internet-facing: the gateway and the public route exist first, and the load balancer goes before they do.
  depends_on = [aws_internet_gateway.lab, aws_route_table_association.public, aws_route.public_internet]
}

resource "aws_lb_target_group" "blue" {
  name                 = "tg-${var.name_prefix}-blue"
  port                 = 80
  protocol             = "HTTP"
  vpc_id               = aws_vpc.lab.id
  deregistration_delay = 30
  health_check {
    path                = "/"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200"
  }
  tags = { Name = "tg-blue" }
}

resource "aws_lb_target_group" "green" {
  name                 = "tg-${var.name_prefix}-green"
  port                 = 80
  protocol             = "HTTP"
  vpc_id               = aws_vpc.lab.id
  deregistration_delay = 30
  health_check {
    path                = "/"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200"
  }
  tags = { Name = "tg-green" }
}

resource "aws_lb_target_group_attachment" "blue" {
  target_group_arn = aws_lb_target_group.blue.arn
  target_id        = aws_instance.blue.id
  port             = 80
}

resource "aws_lb_target_group_attachment" "green" {
  target_group_arn = aws_lb_target_group.green.arn
  target_id        = aws_instance.green.id
  port             = 80
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.alb.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
  tags = { Name = "listener-http" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.alb.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.app.arn
  default_action {
    type = "forward"
    forward {
      target_group {
        arn    = aws_lb_target_group.blue.arn
        weight = 80
      }
      target_group {
        arn    = aws_lb_target_group.green.arn
        weight = 20
      }
    }
  }
  tags = { Name = "listener-https" }
}

resource "aws_lb_listener_rule" "green" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.green.arn
  }
  condition {
    path_pattern {
      values = ["/green/*"]
    }
  }
  tags = { Name = "rule-green" }
}
```

**`labs/ans-25-load-balancing/terraform/nlb.tf`**
```hcl
# nlb.tf
#
# Plain English: lab 25's internet-facing Network Load Balancer, in
# snet-public-1 on its own Elastic IP (eip-nlb: the address never changes,
# which is what an NLB is chosen for). It has a security group of its own
# (TLS 443 and TCP 8080 from the internet), so the web instances can admit it
# by reference. TLS on 443 ends with the same imported certificate as the
# ALB and forwards plain TCP 80 to vm-blue. TCP on 8080 passes straight
# through to vm-green on port 80 with a proxy protocol v2 header in front,
# carrying the caller's own address: vm-green's simple web server does not
# expect that header, which is a Thing to try.

resource "aws_security_group" "nlb" {
  name        = "lab-nlb"
  description = "The NLB: TLS 443 and TCP 8080 from the internet, HTTP on to the web instances"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-nlb" }
}

resource "aws_vpc_security_group_ingress_rule" "nlb_tls" {
  security_group_id = aws_security_group.nlb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "nlb_pp" {
  security_group_id = aws_security_group.nlb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 8080
  to_port           = 8080
}

resource "aws_vpc_security_group_egress_rule" "nlb_to_web" {
  security_group_id            = aws_security_group.nlb.id
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_lb" "nlb" {
  name                       = "nlb-${var.name_prefix}"
  internal                   = false
  load_balancer_type         = "network"
  security_groups            = [aws_security_group.nlb.id]
  enable_deletion_protection = false
  tags                       = { Name = "nlb-app" }

  subnet_mapping {
    subnet_id     = aws_subnet.public[0].id
    allocation_id = aws_eip.nlb.id
  }

  depends_on = [aws_internet_gateway.lab, aws_route_table_association.public, aws_route.public_internet]
}

resource "aws_lb_target_group" "web" {
  name     = "tgn-${var.name_prefix}-web"
  port     = 80
  protocol = "TCP"
  vpc_id   = aws_vpc.lab.id
  tags     = { Name = "tgn-web" }
}

resource "aws_lb_target_group" "pp" {
  name              = "tgn-${var.name_prefix}-pp"
  port              = 80
  protocol          = "TCP"
  vpc_id            = aws_vpc.lab.id
  proxy_protocol_v2 = true
  tags              = { Name = "tgn-pp" }
}

resource "aws_lb_target_group_attachment" "nlb_web" {
  target_group_arn = aws_lb_target_group.web.arn
  target_id        = aws_instance.blue.id
  port             = 80
}

resource "aws_lb_target_group_attachment" "nlb_pp" {
  target_group_arn = aws_lb_target_group.pp.arn
  target_id        = aws_instance.green.id
  port             = 80
}

resource "aws_lb_listener" "tls" {
  load_balancer_arn = aws_lb.nlb.arn
  port              = 443
  protocol          = "TLS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.app.arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
  tags = { Name = "listener-tls" }
}

resource "aws_lb_listener" "pp" {
  load_balancer_arn = aws_lb.nlb.arn
  port              = 8080
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pp.arn
  }
  tags = { Name = "listener-pp" }
}
```

**`labs/ans-25-load-balancing/terraform/gwlb.tf`**
```hcl
# gwlb.tf
#
# Plain English: lab 25's Gateway Load Balancer, in snet-appliance, sending
# every packet it is given to vm-appliance wrapped in GENEVE (UDP 6081) and
# taking it back the same way. Its health check asks the appliance for HTTP
# on port 8080. An endpoint service, vpces-gwlb, offers it to this account
# only and accepts without asking (ruling P13); the lab's one GWLB endpoint,
# vpce-gwlb in snet-gwlbe, is the next hop that snet-inspected's routes
# point at. Tear-down removes the endpoint and the service before the load
# balancer, as AWS requires (ruling P23).

resource "aws_lb" "gwlb" {
  name                       = "gwlb-${var.name_prefix}"
  load_balancer_type         = "gateway"
  subnets                    = [aws_subnet.appliance.id]
  enable_deletion_protection = false
  tags                       = { Name = "gwlb-appliance" }
}

resource "aws_lb_target_group" "gwlb" {
  name        = "tgg-${var.name_prefix}"
  port        = 6081
  protocol    = "GENEVE"
  vpc_id      = aws_vpc.lab.id
  target_type = "instance"
  health_check {
    protocol            = "HTTP"
    port                = "8080"
    path                = "/"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
  tags = { Name = "tgg-appliance" }
}

resource "aws_lb_target_group_attachment" "appliance" {
  target_group_arn = aws_lb_target_group.gwlb.arn
  target_id        = aws_instance.appliance.id
}

resource "aws_lb_listener" "gwlb" {
  load_balancer_arn = aws_lb.gwlb.arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gwlb.arn
  }
  tags = { Name = "listener-gwlb" }
}

resource "aws_vpc_endpoint_service" "gwlb" {
  acceptance_required        = false
  gateway_load_balancer_arns = [aws_lb.gwlb.arn]
  allowed_principals         = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
  tags                       = { Name = "vpces-gwlb" }
}

resource "aws_vpc_endpoint" "gwlb" {
  vpc_id            = aws_vpc.lab.id
  service_name      = aws_vpc_endpoint_service.gwlb.service_name
  vpc_endpoint_type = "GatewayLoadBalancer"
  subnet_ids        = [aws_subnet.gwlbe.id]
  tags              = { Name = "vpce-gwlb" }
}
```

**`labs/ans-25-load-balancing/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 25's four instances, each also in the template's sg-vms
# (SSH from the Instance Connect Endpoint, anything from the VPN server's
# range when peered, everything out). vm-blue (snet-private-1) and vm-green
# (snet-private-2), t4g.nano, each serve a page naming itself on port 80
# (vm-green also /green/) to the ALB and the NLB only (sg-web). vm-client
# (t4g.nano, snet-inspected) is the machine whose internet traffic the
# appliance inspects. vm-appliance (t4g.small, snet-appliance; ruling P14)
# answers the GWLB's health check on port 8080 at once, then installs a
# compiler through the NAT gateway and builds AWS's open-source GWLB tunnel
# handler, gwlbtun, which takes the GENEVE packets apart and hands them back
# (several minutes after the lab is ready; the ready check does not wait).

locals {
  web_unit = join("\n", [
    "[Unit]",
    "Description=Lab 25 web page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  health_unit = join("\n", [
    "[Unit]",
    "Description=Lab 25 appliance health check on port 8080",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 8080 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  gwlbtun_unit = join("\n", [
    "[Unit]",
    "Description=AWS Gateway Load Balancer tunnel handler (lab 25 appliance)",
    "After=network-online.target",
    "ConditionPathExists=/opt/gwlbtun/gwlbtun",
    "[Service]",
    "WorkingDirectory=/opt/gwlbtun",
    "ExecStart=/opt/gwlbtun/gwlbtun -c /opt/gwlbtun/example-scripts/create-route.sh -r /opt/gwlbtun/example-scripts/create-route.sh",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  blue_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-blue (blue target group)\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
  green_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-green (green target group)\n" },
      { path = "/srv/www/green/index.html", permissions = "0644", content = "vm-green, chosen by the /green/ rule\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
  appliance_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-appliance health check\n" },
      { path = "/etc/systemd/system/lab-health.service", permissions = "0644", content = local.health_unit },
      { path = "/etc/systemd/system/gwlbtun.service", permissions = "0644", content = local.gwlbtun_unit },
      { path = "/etc/sysctl.d/90-lab-forward.conf", permissions = "0644", content = "net.ipv4.ip_forward = 1\n" },
    ]
    runcmd = [
      "sysctl --system",
      "systemctl daemon-reload",
      "systemctl enable --now lab-health.service",
      "for i in 1 2 3 4 5; do dnf install -y gcc gcc-c++ cmake make git && break; sleep 10; done",
      "git clone --depth 1 https://github.com/aws-samples/aws-gateway-load-balancer-tunnel-handler /opt/gwlbtun",
      "cd /opt/gwlbtun && cmake . && make",
      "systemctl enable --now gwlbtun.service",
    ]
  }))}"
}

resource "aws_security_group" "web" {
  name        = "lab-web"
  description = "Web instances: HTTP from the ALB and the NLB"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-web" }
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_ingress_rule" "web_from_nlb" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.nlb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_security_group" "appliance" {
  name        = "lab-appliance"
  description = "The appliance: GENEVE and health checks from the GWLB subnet"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-appliance" }
}

resource "aws_vpc_security_group_ingress_rule" "appliance_geneve" {
  security_group_id = aws_security_group.appliance.id
  cidr_ipv4         = local.appliance_cidr
  ip_protocol       = "udp"
  from_port         = 6081
  to_port           = 6081
}

resource "aws_vpc_security_group_ingress_rule" "appliance_health" {
  security_group_id = aws_security_group.appliance.id
  cidr_ipv4         = local.appliance_cidr
  ip_protocol       = "tcp"
  from_port         = 8080
  to_port           = 8080
}

resource "aws_security_group" "client" {
  name        = "lab-client"
  description = "vm-client: ping from the lab VPC"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-client" }
}

resource "aws_vpc_security_group_ingress_rule" "client_ping" {
  security_group_id = aws_security_group.client.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_instance" "blue" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.web.id]
  user_data              = local.blue_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-blue" })
  tags        = { Name = "vm-blue" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "green" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[1].id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.web.id]
  user_data              = local.green_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-green" })
  tags        = { Name = "vm-green" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "client" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.inspected.id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.client.id]
  user_data              = local.cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-client" })
  tags        = { Name = "vm-client" }
  depends_on  = [aws_route.inspected_gwlbe, aws_route_table_association.inspected]
}

resource "aws_instance" "appliance" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.small"
  subnet_id              = aws_subnet.appliance.id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.appliance.id]
  user_data              = local.appliance_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-appliance" })
  tags        = { Name = "vm-appliance" }
  depends_on  = [aws_route.appliance_nat, aws_route_table_association.appliance]
}
```

**`labs/ans-25-load-balancing/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 25 is up: the four
# instances' addresses; console SSH to the client and the appliance; the ALB's
# name and the NLB's fixed address for curl from anywhere (the certificate is
# self-signed, hence -k); and, while peered, vm-blue.

output "private_ips" {
  value = {
    "vm-blue"      = aws_instance.blue.private_ip
    "vm-green"     = aws_instance.green.private_ip
    "vm-client"    = aws_instance.client.private_ip
    "vm-appliance" = aws_instance.appliance.private_ip
  }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.client.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.appliance.id} --os-user labadmin --connection-type eice",
    "ALB: curl -k https://${aws_lb.alb.dns_name}/   (self-signed certificate: -k)",
    "NLB: curl -k https://${aws_eip.nlb.public_ip}/   (TLS 443)   and   curl http://${aws_eip.nlb.public_ip}:8080/   (proxy protocol)",
    "ssh labadmin@${aws_instance.blue.private_ip}",
    "curl http://${aws_instance.blue.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/ans-25-load-balancing/readme.md`** (exactly):
````markdown
All three kinds of Elastic Load Balancing in one VPC, each doing the job it is chosen for. An Application Load Balancer ends HTTPS with a certificate you imported, splits traffic 80/20 between a blue and a green target group and sends one path to green alone. A Network Load Balancer keeps one fixed public address, passes TLS and plain TCP, and can tell the server who really called with proxy protocol. A Gateway Load Balancer sends one subnet's internet traffic through an inspection appliance and back, without either end noticing. Everything is listed in the lab's resource group, `lab-ans-25-load-balancing`, in AWS Resource Groups (London).
From the ANS-C01 outline: design and implement load balancing for performance, availability and security, including TLS termination, static addressing and third-party appliances behind a Gateway Load Balancer.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20) with seven subnets: `snet-private-1/2` (the web instances), `snet-public-1/2` (the ALB, the NLB and the NAT gateway `nat-lab`), and in the first zone `snet-appliance`, `snet-gwlbe` and `snet-inspected`
- A certificate for `app.<name prefix>.internal`, signed by a CA the lab makes ("cloudlabs ans-25 CA") and imported to ACM as `cert-app`
- The ALB `alb-<name prefix>` (Name `alb-app`): HTTP 80 redirects to HTTPS; HTTPS 443 forwards 80% to `tg-blue` (`vm-blue`) and 20% to `tg-green` (`vm-green`), and a rule sends `/green/*` to green only
- The NLB `nlb-<name prefix>` (Name `nlb-app`) on the Elastic IP `eip-nlb`: TLS 443 to `vm-blue` on port 80, and TCP 8080 to `vm-green` with a proxy protocol v2 header
- The Gateway Load Balancer `gwlb-<name prefix>` (Name `gwlb-appliance`) in `snet-appliance`, its endpoint service `vpces-gwlb` (this account only), and the endpoint `vpce-gwlb` in `snet-gwlbe`
- Four instances: `vm-blue`, `vm-green` and `vm-client` (t4g.nano) and the appliance `vm-appliance` (t4g.small), which builds AWS's open-source tunnel handler, `gwlbtun`, when it starts
- The routes that make the inspection path: `snet-inspected`'s default route is `vpce-gwlb`, and `rt-public` sends replies for `snet-inspected` back through it

The lab is ready in about 10 minutes, but the appliance compiles its software for several minutes more: until `gwlbtun` is running, `vm-client` has no internet. Sign in as `labadmin` with the password behind **Show**.

```text
lab-ans-25-load-balancing (London), vpc-lab
  you --HTTP 80 (redirect) / HTTPS 443--> alb-app --80%--> vm-blue (snet-private-1)
                                                  --20%, and /green/*--> vm-green (snet-private-2)
  you --TLS 443--> nlb-app (eip-nlb) --TCP 80--> vm-blue
  you --TCP 8080--> nlb-app --proxy protocol v2--> vm-green
  vm-client (snet-inspected) --0.0.0.0/0--> vpce-gwlb --> gwlb-appliance --GENEVE 6081--> vm-appliance
      --> back to vpce-gwlb --> nat-lab --> igw-lab --> internet (replies: rt-public --> vpce-gwlb --> vm-client)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Count the split: `for i in $(seq 20); do curl -sk https://<the ALB's name>/; done | sort | uniq -c` gives about 16 blue and 4 green. Ask for `https://<the ALB's name>/green/` and it is always green. `curl -sI http://<the ALB's name>/` shows the 301 redirect to HTTPS.
- Read the certificate both load balancers present: `openssl s_client -connect <the NLB's address>:443 -servername app.<name prefix>.internal </dev/null | openssl x509 -noout -subject -issuer -dates`. In ACM (London) it is listed as Imported: ACM never renews an imported certificate, so you would import its replacement yourself.
- Try proxy protocol: `curl http://<the NLB's address>:8080/` comes back as an error page, because `vm-green`'s simple web server does not expect the extra header. On `vm-green` (Instance Connect) run `sudo dnf install -y tcpdump && sudo tcpdump -A -n -i any tcp port 80` and call it again: the first bytes are the proxy protocol v2 signature, followed by your own public address. Real servers (nginx, HAProxy) read that header to log the true client.
- Follow a packet through the appliance: on `vm-client`, `curl -sI https://aws.amazon.com`; on `vm-appliance`, `sudo tcpdump -n -i any udp port 6081` shows the same traffic wrapped in GENEVE, and `ip link` shows the `gwi-` interfaces `gwlbtun` made. Then `sudo systemctl stop gwlbtun` on the appliance: `vm-client` loses the internet, yet the target stays healthy, because the health check on port 8080 never touches the data path. Start it again with `sudo systemctl start gwlbtun`.
- Time the appliance's build: `aws ec2 get-console-output --instance-id <vm-appliance's id> --latest --output text | tail -40` in CloudShell shows the compile; `systemctl status gwlbtun` on the appliance shows when it started.

## Learn more

- [Listeners for your Application Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html)
- [Target groups for your Network Load Balancers (client IP preservation and proxy protocol)](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-target-groups.html)
- [What is a Gateway Load Balancer?](https://docs.aws.amazon.com/elasticloadbalancing/latest/gateway/introduction.html)
- [Access virtual appliances through Gateway Load Balancer endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpce-gateway-load-balancer.html)
- [Importing certificates into AWS Certificate Manager](https://docs.aws.amazon.com/acm/latest/userguide/import-certificate.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-25-load-balancing` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-25-load-balancing.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Use all three Elastic Load Balancing types for what each does best, and see an appliance inspect traffic in line.
learn:
  - Split HTTPS traffic by weight and by path on an ALB with an imported certificate
  - Give an NLB a fixed address and read the proxy protocol header it adds
  - Send a subnet's internet traffic through a Gateway Load Balancer appliance and back
learning_min: 75
```

**The diagram** must contain: `resourceGroup lab-ans-25-load-balancing · London`; `vnet vpc-lab` with `subnet snet-private-1`, `snet-private-2`, `snet-public-1`, `snet-public-2`, `snet-appliance`, `snet-gwlbe`, `snet-inspected`; `internetGateway igw-lab`; `natGateway nat-lab`; `loadBalancer alb-app` with `traffic` edges `HTTPS 443` to `vm vm-blue` and to `vm vm-green`; `loadBalancer nlb-app` with `traffic` edges `TLS 443` to `vm-blue` and `TCP 8080` to `vm-green`; `loadBalancer gwlb-appliance` with a `traffic` edge to `vm vm-appliance`; `privateLinkService vpces-gwlb` with a `dependency` edge `fronts` to `gwlb-appliance`; `privateEndpoint vpce-gwlb`, `vpce-s3`; `routeTable rt-private`, `rt-public` (a `dependency` edge `0.0.0.0/0` to `igw-lab`), `rt-appliance` and `rt-gwlbe` (each a `dependency` edge `0.0.0.0/0` to `nat-lab`), `rt-inspected`; `generic cert-app`; `vm vm-client`; `nsg sg-alb`, `sg-nlb`, `sg-web`, `sg-appliance`, `sg-client`, `sg-vms`, `sg-eice`; `bastion eice-lab`. No `tls_*` node.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-ans-25.test.mjs`:

```js
// labs-aws-ans-25.test.mjs
//
// Plain English: lab ans-25-load-balancing is the lab AWS labs spec §12.2
// row 25 describes: an ALB with weighted target groups and a path rule on an
// imported self-signed certificate, an NLB on a static Elastic IP with TLS and
// proxy protocol, and a Gateway Load Balancer with a GENEVE appliance that
// inspects one subnet's internet traffic (rulings P13, P14).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-25-load-balancing";
const block = (lab, type, name) => resources(lab, type).find((r) => r.labels[1] === name)?.body ?? "";

test("ans-25 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-25's lab.yaml: §12.2 row 25, after soa-03, one /20, about £0.15/h with the load balancers, the GWLB endpoint and NAT billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.security"], ["soa-03-auto-scaling"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 10, destroy_min: 8, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 1 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.small", "t4g.nano", "t4g.nano", "t4g.nano"] });
  assert.deepEqual(yaml.regions, { secondary: null });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.13 && total < 0.17, `about £0.15/h, got ${total}`);
  for (const n of ["Application Load Balancer, hourly", "Network Load Balancer, hourly", "Gateway Load Balancer, hourly", "Gateway Load Balancer endpoint, one AZ", "NAT gateway, hourly"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
  assert.equal(yaml.cost.items.find((i) => i.name.startsWith("Public IPv4")).qty, 4);
});

test("ruling P14: the certificate is imported from the lab's own tls resources, RSA 2048, valid a week", () => {
  const { lab, tf } = awsLab(ID);
  const cert = block(lab, "aws_acm_certificate", "app");
  for (const re of [/private_key\s+= tls_private_key\.server\.private_key_pem/, /certificate_body\s+= tls_locally_signed_cert\.server\.cert_pem/, /certificate_chain = tls_self_signed_cert\.ca\.cert_pem/]) assert.match(cert, re);
  assert.doesNotMatch(cert, /domain_name|validation_method|certificate_authority_arn/);
  assert.equal([...tf.matchAll(/rsa_bits\s+= 2048/g)].length, 2);
  assert.equal([...tf.matchAll(/validity_period_hours = 168/g)].length, 2);
  assert.match(tf, /dns_names\s+= \["app\.\$\{var\.name_prefix\}\.internal"\]/);
});

test("the ALB: HTTP redirects, HTTPS on the imported certificate forwards blue 80 / green 20, /green/* goes to green", () => {
  const { lab } = awsLab(ID);
  assert.match(block(lab, "aws_lb", "alb"), /internal\s+= false/);
  const http = block(lab, "aws_lb_listener", "http");
  for (const re of [/type = "redirect"/, /protocol\s+= "HTTPS"/, /status_code = "HTTP_301"/]) assert.match(http, re);
  const https = block(lab, "aws_lb_listener", "https");
  for (const re of [/certificate_arn\s+= aws_acm_certificate\.app\.arn/, /ssl_policy\s+= "ELBSecurityPolicy-TLS13-1-2-2021-06"/, /arn\s+= aws_lb_target_group\.blue\.arn\n\s+weight = 80/, /arn\s+= aws_lb_target_group\.green\.arn\n\s+weight = 20/]) assert.match(https, re);
  const rule = block(lab, "aws_lb_listener_rule", "green");
  for (const re of [/priority\s+= 10/, /values = \["\/green\/\*"\]/, /target_group_arn = aws_lb_target_group\.green\.arn/]) assert.match(rule, re);
});

test("the NLB: one Elastic IP subnet mapping, its own security group, TLS 443 on the same certificate, TCP 8080 to a proxy protocol v2 group", () => {
  const { lab } = awsLab(ID);
  const nlb = block(lab, "aws_lb", "nlb");
  for (const re of [/load_balancer_type\s+= "network"/, /security_groups\s+= \[aws_security_group\.nlb\.id\]/, /allocation_id = aws_eip\.nlb\.id/]) assert.match(nlb, re);
  assert.match(block(lab, "aws_lb_listener", "tls"), /protocol\s+= "TLS"[\s\S]*certificate_arn\s+= aws_acm_certificate\.app\.arn/);
  assert.match(block(lab, "aws_lb_listener", "pp"), /port\s+= 8080/);
  assert.match(block(lab, "aws_lb_target_group", "pp"), /proxy_protocol_v2 = true/);
  assert.match(block(lab, "aws_vpc_security_group_ingress_rule", "web_from_nlb"), /referenced_security_group_id = aws_security_group\.nlb\.id/);
});

test("ruling P13: the GWLB's endpoint service is this account's only, its endpoint is the inspected subnet's next hop both ways, the appliance a t4g.small with no public address", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(block(lab, "aws_lb", "gwlb"), /load_balancer_type\s+= "gateway"/);
  assert.match(block(lab, "aws_lb_target_group", "gwlb"), /port\s+= 6081\n\s+protocol\s+= "GENEVE"/);
  const svc = block(lab, "aws_vpc_endpoint_service", "gwlb");
  for (const re of [/acceptance_required\s+= false/, /gateway_load_balancer_arns = \[aws_lb\.gwlb\.arn\]/, /allowed_principals\s+= \["arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:root"\]/]) assert.match(svc, re);
  assert.doesNotMatch(svc, /private_dns_name|supported_regions/);
  assert.match(block(lab, "aws_vpc_endpoint", "gwlb"), /service_name\s+= aws_vpc_endpoint_service\.gwlb\.service_name\n\s+vpc_endpoint_type = "GatewayLoadBalancer"/);
  for (const r of ["public_inspected", "inspected_gwlbe"]) assert.match(block(lab, "aws_route", r), /vpc_endpoint_id\s+= aws_vpc_endpoint\.gwlb\.id/, r);
  assert.match(block(lab, "aws_route", "public_inspected"), /destination_cidr_block = local\.inspected_cidr/);
  const app = block(lab, "aws_instance", "appliance");
  assert.match(app, /instance_type\s+= "t4g\.small"/);
  assert.doesNotMatch(tf, /associate_public_ip_address|aws_eip_association/);
  assert.match(tf, /aws-gateway-load-balancer-tunnel-handler/);
  assert.equal([...tf.matchAll(/resource "aws_nat_gateway"/g)].length, 1);
});

test("ans-25's readme names each load balancer's trick and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["alb-app", "nlb-app", "gwlb-appliance", "vpces-gwlb", "eip-nlb", "/green/", "proxy protocol", "gwlbtun", "cert-app"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-ans-25.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged from `labs/_template-aws/`; trim `variables.tf` to the seven variables named; `terraform fmt -check` clean where terraform is installed (CI's `labs-tf` runs it otherwise).

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/ans-25-load-balancing.mjs` (header comment in the house form, naming the files in order): `c = ctxAws("ans-25-load-balancing", "25")`; `variables: c.variables`; `providers: ["aws"]` (the tls resources are recognised by their type prefix, as batch 3's `time_sleep` and `random_password` are); `providerConfig: AWS_PROVIDER_CONFIG`; `data: awsData()`; resources in file order:
  - `...templateResources(c)`.
  - **subnets.tf**: `aws_subnet.public[0]`, `[1]` (`count: 2`; known `cidr_block` `cidrsubnet(c.vpcCidr, 4, 2 + i)`, `availability_zone` `eu-west-2a`/`b`, `map_public_ip_on_launch: false`, `tags.Name` `snet-public-<i+1>`; unknown `vpc_id` → `aws_vpc.lab.id`; refs `cidr_block: ["local.public_cidrs", "count.index"]`, `availability_zone: ["local.azs", "count.index"]`, `tags: ["count.index"]`); `aws_subnet.appliance`, `.gwlbe`, `.inspected` (known `cidrsubnet(c.vpcCidr, 4, 4/5/6)`, `eu-west-2a`; refs `local.appliance_cidr` etc. and `local.azs[0]`); `aws_internet_gateway.lab` (unknown `vpc_id`); `aws_eip.nat`, `aws_eip.nlb` (known `domain: "vpc"`, Names); `aws_nat_gateway.lab` (unknown `allocation_id` → `aws_eip.nat.id`, `subnet_id` → `aws_subnet.public[0]`); the four route tables (unknown `vpc_id`); the five routes (known `destination_cidr_block`: `"0.0.0.0/0"` or the inspected `/24` with ref `local.inspected_cidr`; unknown `route_table_id` and the target: `gateway_id` → `aws_internet_gateway.lab.id`, `nat_gateway_id` → `aws_nat_gateway.lab.id`, `vpc_endpoint_id` → `aws_vpc_endpoint.gwlb.id`); the five associations (`public[0..1]` with `count.index` refs, then appliance, gwlbe, inspected; all ids unknown with refs).
  - **certs.tf**: `tls_private_key.ca`, `.server` (known `algorithm: "RSA"`, `rsa_bits: 2048`; the PEMs computed, so unknown, and `private_key_pem` sensitive, as `computed.json` gives them); `tls_self_signed_cert.ca` (known `is_ca_certificate: true`, `validity_period_hours: 168`, `allowed_uses`, `subject: [{ common_name: "cloudlabs ans-25 CA", organization: "cloudlabs" }]`; unknown and sensitive `private_key_pem` → `tls_private_key.ca.private_key_pem`); `tls_cert_request.server` (known `dns_names: ["app.a25k3x9q.internal"]` and `subject` with refs `var.name_prefix`; unknown, sensitive `private_key_pem` → `tls_private_key.server`); `tls_locally_signed_cert.server` (known `validity_period_hours`, `allowed_uses`; unknown `cert_request_pem` → `tls_cert_request.server.cert_request_pem`, `ca_private_key_pem` (sensitive) → `tls_private_key.ca`, `ca_cert_pem` → `tls_self_signed_cert.ca.cert_pem`); `aws_acm_certificate.app` (known `tags.Name: "cert-app"`; unknown `private_key` (sensitive) → `tls_private_key.server.private_key_pem`, `certificate_body` → `tls_locally_signed_cert.server.cert_pem`, `certificate_chain` → `tls_self_signed_cert.ca.cert_pem`; no `domain_name`).
  - **alb.tf**: `aws_security_group.alb` (known name, description, Name; unknown `vpc_id`); the three rules (known CIDRs, ports; unknown `security_group_id`, and the egress's `referenced_security_group_id` → `aws_security_group.web.id`); `aws_lb.alb` (known `name: "alb-a25k3x9q"`, `internal: false`, `load_balancer_type: "application"`, `enable_deletion_protection: false`; unknown `security_groups`, `subnets` with refs); the two target groups (known name, port, protocol, `deregistration_delay: 30`, the `health_check` block; unknown `vpc_id`); the two attachments (known `port: 80`; unknown `target_group_arn`, `target_id` → `aws_instance.blue.id` / `.green.id`); `aws_lb_listener.http` (known port, protocol, `default_action: [{ type: "redirect", redirect: [{ port: "443", protocol: "HTTPS", status_code: "HTTP_301" }] }]`); `aws_lb_listener.https` (known port, protocol, `ssl_policy`, `default_action: [{ type: "forward", forward: [{ target_group: [{ weight: 80 }, { weight: 20 }] }] }]`; unknown `load_balancer_arn`, `certificate_arn` → `aws_acm_certificate.app.arn`, and `default_action.0.forward.0.target_group` with refs to both groups' `arn`); `aws_lb_listener_rule.green` (known `priority: 10`, `condition` with the path pattern, `action: [{ type: "forward" }]`; unknown `listener_arn` → `aws_lb_listener.https.arn`, `action.0.target_group_arn` → `aws_lb_target_group.green.arn`).
  - **nlb.tf**: `aws_security_group.nlb` and its three rules as alb.tf's; `aws_lb.nlb` (known name, `internal: false`, `load_balancer_type: "network"`; unknown `security_groups` → `aws_security_group.nlb.id`, `subnet_mapping.0.subnet_id` → `aws_subnet.public[0]`, `subnet_mapping.0.allocation_id` → `aws_eip.nlb.id`); `aws_lb_target_group.web`, `.pp` (known; `.pp` `proxy_protocol_v2: true`); the attachments `nlb_web` (→ blue), `nlb_pp` (→ green); `aws_lb_listener.tls` (known `port: 443`, `protocol: "TLS"`, `ssl_policy`; unknown `certificate_arn`, `default_action.0.target_group_arn` → `aws_lb_target_group.web.arn`), `aws_lb_listener.pp` (known `port: 8080`, `protocol: "TCP"`; unknown target group → `.pp`).
  - **gwlb.tf**: `aws_lb.gwlb` (known name, `load_balancer_type: "gateway"`; unknown `subnets` → `aws_subnet.appliance.id`); `aws_lb_target_group.gwlb` (known `port: 6081`, `protocol: "GENEVE"`, `target_type: "instance"`, the HTTP 8080 `health_check`); `aws_lb_target_group_attachment.appliance` (unknown `target_id` → `aws_instance.appliance.id`); `aws_lb_listener.gwlb` (unknown `load_balancer_arn`, `default_action.0.target_group_arn`); `aws_vpc_endpoint_service.gwlb` (known `acceptance_required: false`, `allowed_principals: ["arn:aws:iam::123456789012:root"]` with ref `data.aws_caller_identity.current.account_id`; unknown `gateway_load_balancer_arns` → `aws_lb.gwlb.arn`); `aws_vpc_endpoint.gwlb` (known `vpc_endpoint_type: "GatewayLoadBalancer"`; unknown `vpc_id`, `service_name` → `aws_vpc_endpoint_service.gwlb.service_name`, `subnet_ids` → `aws_subnet.gwlbe.id`).
  - **compute.tf**: `aws_security_group.web`, `.appliance`, `.client` and their five ingress rules (CIDRs `local.appliance_cidr` / `local.vpc_cidr` known with refs; ICMP `from_port: -1`, `to_port: -1`); the instances `al2023Instance(c, { key: "blue", name: "vm-blue", type: "t4g.nano", sgs: ["aws_security_group.vms", "aws_security_group.web"] })` with `refs.user_data = ["local.blue_cloud_init"]`, `green` (`subnet: "aws_subnet.private[1]"`, `local.green_cloud_init`), `client` (`subnet: "aws_subnet.inspected"`, `sgs: [vms, client]`, `refs.user_data = ["local.cloud_init"]`), `appliance` (`type: "t4g.small"`, `subnet: "aws_subnet.appliance"`, `sgs: [vms, appliance]`, `local.appliance_cloud_init`); every `user_data` known at plan and sensitive (it holds the session's password).
  `lab-plans.test.mjs` proves it, the scope check included.

- [ ] **Step 5: Generate the planned graph and the readme diagram** (`npm run labs-topology -- ans-25-load-balancing`, `npm run labs-diagrams -- ans-25-load-balancing`), read the generated nodes and edges against the diagram list above, add `GOLDEN["ans-25-load-balancing"]` (the generated `kind name < container` lines and edges) to `worker/test/topology-golden.test.ts` and the id to `AWS_LAB_IDS` in `worker/test/fixtures/topology/round-trip.ts`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-25.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-25-load-balancing`, `npm run labs-topology -- --check ans-25-load-balancing`, `npm run labs-diagrams -- --check`
Expected: all PASS (`labs-tf` skips with its reason where terraform is missing; CI runs it).

- [ ] **Step 7: Commit**

```bash
git add labs/ans-25-load-balancing labs/_learning/ans-25-load-balancing.yaml shared/topology/planned/ans-25-load-balancing.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-25 load balancing in depth: ALB, NLB and GWLB

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 17: Lab ans-26-edge

Spec: §12.2 row 26 (design, security, soa.networking; expert; explore; £ 0.04; peering off; 12/15; 2/3; prerequisite 09; CloudFront with an origin group (failover), CloudFront Function, WAF web ACL (us-east-1), Global Accelerator to London and Ireland, here through two NLBs: P9) and "Not built here" (Shield Advanced); §3.1 (CloudFront functions owned by name, A4); §4 (providers: the default and `secondary` blocks only; the WAF ACL's per-resource region); §5.1 (CloudFront `Deployed`, Global Accelerator `DEPLOYED`); §7.4 (CloudFront, Global Accelerator, internet-facing NLBs); rulings A4, A65, A66, A87, P1, P9, P10, P24.

**Files:**
- Create: `labs/ans-26-edge/lab.yaml`, `readme.md`
- Create: `labs/ans-26-edge/terraform/versions.tf`, `main.tf`, `network.tf` (all three copied unchanged from `labs/_template-aws/`), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `secondary_region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`, each block exactly as the template writes it), `london.tf`, `ireland.tf`, `accelerator.tf`, `cdn.tf`, `waf.tf`, `outputs.tf`
- Create: `labs/_learning/ans-26-edge.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-26-edge.mjs`
- Create (generated): `shared/topology/planned/ans-26-edge.json`, `shared/guides/ans-26-edge/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`, `shared/guides/{index,placement}.json` (generated)
- Test: `scripts/test/labs-aws-ans-26.test.mjs`

**Interfaces:**
- Consumes: the template network; Task 1 (`AWS_GA_LABS`, `readsUsWest2`; `LAB_REGIONS` `eu-west-2 eu-west-1 us-east-1 us-west-2`); Task 2 (Global Accelerator in us-west-2 and CloudFront functions under `GlobalServices`, the CLOUDFRONT web ACL's tagged create in us-east-1, `globalaccelerator` made ahead); Task 3 (`aws_globalaccelerator_*`, `aws_cloudfront_function`, `aws_wafv2_web_acl` on `AWS_TYPES`; rule 1's `GLOBAL_REGION_TYPES` for the ACL's own region); Task 4 (`batch4Problems`: endpoint groups in a lab region naming the lab's own load balancers with `client_ip_preservation_enabled = false`, the listener the lab's own, no BYOIP, accelerator flow logs off; a CLOUDFRONT ACL with AWS-vendor groups only and no paid group, at most 5 rules; the distribution's function and ACL by reference, no Lambda@Edge, no logging; rule 1's per-resource region); Task 5 (Global Accelerator taken apart in us-west-2, the ACL and the function after the distribution, the disable retried, P10); Task 8 (the Worker's us-west-2 read; the global groups' labels); Task 10 (`trafficManager`, `wafPolicy`, the endpoint groups' edges, the function folded into the distribution).
- Consumes also Task 3's `amiProblems` (through `commonAwsProblems`): `vm-ireland` reads `data.aws_ssm_parameter.al2023_ireland` under `aws.secondary`, the name lab 29 uses too; this task never edits `aws-content.mjs`.
- Produces nothing other tasks call.

**`labs/ans-26-edge/lab.yaml`**
```yaml
# Lab ans-26 (AWS labs batch 4). ANS-C01 ((V) the wording against the current
# exam guide): Network Design (edge services: CloudFront origin failover and
# functions, Global Accelerator's anycast addresses and endpoint groups);
# Network Security, Compliance, and Governance (a WAF web ACL at the edge);
# SOA-C03 Networking and Content Delivery (CloudFront).
# Four regions (ruling P9): London and Ireland (the load balancers and
# instances), us-east-1 (the WAF ACL, per-resource region; CloudFront is
# signed there by the default provider) and us-west-2 (Global Accelerator,
# signed there by the default provider, V; Task 24).
# London list prices × 0.75 (labs-verify --aws-prices); the NLBs bill each
# started hour whole (V, A20); Ireland items are region: secondary. Authored
# (no regional hourly product): Global Accelerator's fixed fee ($0.025 an
# hour, whole hours), the WAF ACL ($5 a month) and its two rules ($1 a month
# each), believed prorated hourly (V, Task 23 Step 3: about £4.70 more if a
# whole month is billed), and requests and data for light test traffic.
id: ans-26-edge
version: 1
cloud: aws
title: "Edge: CloudFront, WAF and Global Accelerator"
summary: >-
  The same small site in London and Ireland, each behind its own Network Load Balancer, reached two ways: through
  CloudFront with an origin group that fails over to Ireland, a CloudFront Function and a WAF web ACL, and through
  Global Accelerator's two fixed anycast addresses.
exam: ANS-C01
skill_areas: [ans.design, ans.security, soa.networking]
level: expert
type: explore
prerequisites: [soa-09-route53-cloudfront]
cost:
  items:
    - { name: "Global Accelerator fixed fee ($0.025 an hour)", gbp_h: 0.0188, whole_hours: true }
    - { name: "Global Accelerator data transfer premium, light test traffic", gbp_h: 0.0005 }
    - name: "Network Load Balancer, London, hourly"
      gbp_h: 0.0198
      whole_hours: true
      aws_price: { service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Network", usagetype: "{usage}-LoadBalancerUsage" } }
    - name: "Network Load Balancer, Ireland, hourly"
      gbp_h: 0.0189
      whole_hours: true
      region: secondary
      aws_price: { service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Network", usagetype: "{usage}-LoadBalancerUsage" } }
    - name: "Public IPv4 address, London (the NLB's)"
      gbp_h: 0.0038
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - name: "Public IPv4 address, Ireland (the NLB's)"
      gbp_h: 0.0038
      region: secondary
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - name: "EC2 t4g.nano, Linux, London (vm-london)"
      gbp_h: 0.0035
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EC2 t4g.nano, Linux, Ireland (vm-ireland)"
      gbp_h: 0.0034
      region: secondary
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB, London"
      gbp_h: 0.0008
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - name: "EBS gp3 root volume, 8 GiB, Ireland"
      gbp_h: 0.0007
      region: secondary
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "WAF web ACL and 2 rules ($7 a month, prorated hourly)", gbp_h: 0.0072 }
    - { name: "WAF and CloudFront requests, light test traffic", gbp_h: 0.0002 }
    - { name: "EC2 Instance Connect Endpoints (London and Ireland)", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 12, destroy_min: 15, session_h: 2, max_h: 3 }
capacity: { instance_types: [t4g.nano, t4g.nano] }
regions: { secondary: eu-west-1 }
connectivity: { peering: "off", dns_link: false, subnets_used: 2 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/ans-26-edge/terraform/london.tf`**
```hcl
# london.tf
#
# Plain English: lab 26's London site. vm-london (t4g.nano) in the template's
# snet-private-1 serves a page naming itself on port 80. In front of it, the
# internet-facing Network Load Balancer nlb-<name_prefix>-ldn in a public
# subnet of its own (the slot's /24 2, with an internet gateway). The NLB has
# no security group (ruling P9), so it keeps each caller's address and
# vm-london's group admits port 80 from anywhere; the instance still has no
# public address of its own. CloudFront and Global Accelerator both reach
# London through this load balancer.

locals {
  web_unit = join("\n", [
    "[Unit]",
    "Description=Lab 26 page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  london_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-london in eu-west-2 (London)\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 4, 2)
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-public-1" }
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "igw-lab" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.lab.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "web" {
  name        = "lab-web"
  description = "vm-london: HTTP from anywhere through the NLB, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-web" }
}

resource "aws_vpc_security_group_ingress_rule" "web_http" {
  security_group_id = aws_security_group.web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "web_ssh" {
  security_group_id            = aws_security_group.web.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "web_all" {
  security_group_id = aws_security_group.web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "london" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.web.id]
  user_data              = local.london_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-london" })
  tags        = { Name = "vm-london" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_lb" "london" {
  name                       = "nlb-${var.name_prefix}-ldn"
  internal                   = false
  load_balancer_type         = "network"
  subnets                    = [aws_subnet.public.id]
  enable_deletion_protection = false
  tags                       = { Name = "nlb-ldn" }

  depends_on = [aws_internet_gateway.lab, aws_route_table_association.public, aws_route.public_internet]
}

resource "aws_lb_target_group" "london" {
  name     = "tg-${var.name_prefix}-ldn"
  port     = 80
  protocol = "TCP"
  vpc_id   = aws_vpc.lab.id
  tags     = { Name = "tg-ldn" }
}

resource "aws_lb_target_group_attachment" "london" {
  target_group_arn = aws_lb_target_group.london.arn
  target_id        = aws_instance.london.id
  port             = 80
}

resource "aws_lb_listener" "london" {
  load_balancer_arn = aws_lb.london.arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.london.arn
  }
  tags = { Name = "listener-ldn" }
}
```

**`labs/ans-26-edge/terraform/ireland.tf`**
```hcl
# ireland.tf
#
# Plain English: lab 26's Ireland site (eu-west-1, the session's secondary
# region). The second aws provider, alias secondary, exactly as spec §4
# writes it, and the lab's resource group there (groups are regional). A VPC
# of its own, the slot's second /20, with a private subnet for vm-ireland
# (the same page, naming Ireland), a public subnet for its Network Load
# Balancer nlb-<name_prefix>-dub (no security group, ruling P9), an internet
# gateway, a free S3 gateway endpoint and an Instance Connect Endpoint. The
# instance reads the same public Amazon Linux 2023 parameter, in Ireland.

provider "aws" {
  alias  = "secondary"
  region = var.secondary_region
  default_tags {
    tags = var.tags
  }
}

data "aws_availability_zones" "ireland" {
  provider = aws.secondary
  state    = "available"
}

data "aws_ssm_parameter" "al2023_ireland" {
  provider = aws.secondary
  name     = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

locals {
  ireland_vpc_cidr     = cidrsubnet(var.address_space, 2, 1)
  ireland_private_cidr = cidrsubnet(local.ireland_vpc_cidr, 4, 0)
  ireland_public_cidr  = cidrsubnet(local.ireland_vpc_cidr, 4, 1)
  ireland_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-ireland in eu-west-1 (Ireland)\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_resourcegroups_group" "secondary" {
  provider = aws.secondary
  name     = "lab-${var.lab_id}"

  resource_query {
    type = "TAG_FILTERS_1_0"
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters          = [{ Key = "cloudlabs-lab", Values = [var.lab_id] }]
    })
  }
}

resource "aws_vpc" "ireland" {
  provider             = aws.secondary
  cidr_block           = local.ireland_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-ireland" }
}

resource "aws_subnet" "ireland_private" {
  provider                = aws.secondary
  vpc_id                  = aws_vpc.ireland.id
  cidr_block              = local.ireland_private_cidr
  availability_zone       = data.aws_availability_zones.ireland.names[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-ireland-private" }
}

resource "aws_subnet" "ireland_public" {
  provider                = aws.secondary
  vpc_id                  = aws_vpc.ireland.id
  cidr_block              = local.ireland_public_cidr
  availability_zone       = data.aws_availability_zones.ireland.names[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-ireland-public" }
}

resource "aws_internet_gateway" "ireland" {
  provider = aws.secondary
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "igw-ireland" }
}

resource "aws_route_table" "ireland_private" {
  provider = aws.secondary
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "rt-ireland-private" }
}

resource "aws_route_table" "ireland_public" {
  provider = aws.secondary
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "rt-ireland-public" }
}

resource "aws_route" "ireland_public_internet" {
  provider               = aws.secondary
  route_table_id         = aws_route_table.ireland_public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.ireland.id
}

resource "aws_route_table_association" "ireland_private" {
  provider       = aws.secondary
  subnet_id      = aws_subnet.ireland_private.id
  route_table_id = aws_route_table.ireland_private.id
}

resource "aws_route_table_association" "ireland_public" {
  provider       = aws.secondary
  subnet_id      = aws_subnet.ireland_public.id
  route_table_id = aws_route_table.ireland_public.id
}

resource "aws_vpc_endpoint" "ireland_s3" {
  provider          = aws.secondary
  vpc_id            = aws_vpc.ireland.id
  service_name      = "com.amazonaws.${var.secondary_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.ireland_private.id]
  tags              = { Name = "vpce-s3-ireland" }
}

resource "aws_security_group" "ireland_eice" {
  provider    = aws.secondary
  name        = "lab-eice-ireland"
  description = "EC2 Instance Connect Endpoint in Ireland: SSH out to vm-ireland"
  vpc_id      = aws_vpc.ireland.id
  tags        = { Name = "sg-eice-ireland" }
}

resource "aws_vpc_security_group_egress_rule" "ireland_eice_ssh" {
  provider          = aws.secondary
  security_group_id = aws_security_group.ireland_eice.id
  cidr_ipv4         = local.ireland_vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "ireland" {
  provider           = aws.secondary
  subnet_id          = aws_subnet.ireland_private.id
  security_group_ids = [aws_security_group.ireland_eice.id]
  preserve_client_ip = false
  tags               = { Name = "eice-ireland" }
}

resource "aws_security_group" "ireland_web" {
  provider    = aws.secondary
  name        = "lab-web-ireland"
  description = "vm-ireland: HTTP from anywhere through the NLB, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.ireland.id
  tags        = { Name = "sg-web-ireland" }
}

resource "aws_vpc_security_group_ingress_rule" "ireland_web_http" {
  provider          = aws.secondary
  security_group_id = aws_security_group.ireland_web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "ireland_web_ssh" {
  provider                     = aws.secondary
  security_group_id            = aws_security_group.ireland_web.id
  referenced_security_group_id = aws_security_group.ireland_eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "ireland_web_all" {
  provider          = aws.secondary
  security_group_id = aws_security_group.ireland_web.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "ireland" {
  provider               = aws.secondary
  ami                    = data.aws_ssm_parameter.al2023_ireland.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.ireland_private.id
  vpc_security_group_ids = [aws_security_group.ireland_web.id]
  user_data              = local.ireland_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-ireland" })
  tags        = { Name = "vm-ireland" }
  depends_on  = [aws_vpc_endpoint.ireland_s3, aws_route_table_association.ireland_private]
}

resource "aws_lb" "ireland" {
  provider                   = aws.secondary
  name                       = "nlb-${var.name_prefix}-dub"
  internal                   = false
  load_balancer_type         = "network"
  subnets                    = [aws_subnet.ireland_public.id]
  enable_deletion_protection = false
  tags                       = { Name = "nlb-dub" }

  depends_on = [aws_internet_gateway.ireland, aws_route_table_association.ireland_public, aws_route.ireland_public_internet]
}

resource "aws_lb_target_group" "ireland" {
  provider = aws.secondary
  name     = "tg-${var.name_prefix}-dub"
  port     = 80
  protocol = "TCP"
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "tg-dub" }
}

resource "aws_lb_target_group_attachment" "ireland" {
  provider         = aws.secondary
  target_group_arn = aws_lb_target_group.ireland.arn
  target_id        = aws_instance.ireland.id
  port             = 80
}

resource "aws_lb_listener" "ireland" {
  provider          = aws.secondary
  load_balancer_arn = aws_lb.ireland.arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ireland.arn
  }
  tags = { Name = "listener-dub" }
}
```

**`labs/ans-26-edge/terraform/accelerator.tf`**
```hcl
# accelerator.tf
#
# Plain English: lab 26's Global Accelerator, lab-<id>: two fixed anycast IPv4
# addresses announced from AWS's edge, a TCP listener on port 80, and two
# endpoint groups, London and Ireland, each holding that region's NLB at full
# weight. A caller enters AWS at the nearest edge and rides AWS's network to
# the nearest healthy group. Client IP preservation is off (ruling P9): with it
# on, Global Accelerator would make untagged network interfaces and a
# security group inside the lab's VPCs. The accelerator's API answers only
# in us-west-2; the default provider signs it there itself (ruling P9, V).

resource "aws_globalaccelerator_accelerator" "lab" {
  name            = "lab-${var.lab_id}"
  ip_address_type = "IPV4"
  enabled         = true
  attributes {
    flow_logs_enabled = false
  }
  tags = { Name = "ga-lab" }
}

resource "aws_globalaccelerator_listener" "http" {
  accelerator_arn = aws_globalaccelerator_accelerator.lab.arn
  client_affinity = "NONE"
  protocol        = "TCP"
  port_range {
    from_port = 80
    to_port   = 80
  }
}

resource "aws_globalaccelerator_endpoint_group" "london" {
  listener_arn            = aws_globalaccelerator_listener.http.arn
  endpoint_group_region   = var.region
  health_check_protocol   = "TCP"
  health_check_port       = 80
  traffic_dial_percentage = 100
  endpoint_configuration {
    endpoint_id                    = aws_lb.london.arn
    weight                         = 100
    client_ip_preservation_enabled = false
  }
}

resource "aws_globalaccelerator_endpoint_group" "ireland" {
  listener_arn            = aws_globalaccelerator_listener.http.arn
  endpoint_group_region   = var.secondary_region
  health_check_protocol   = "TCP"
  health_check_port       = 80
  traffic_dial_percentage = 100
  endpoint_configuration {
    endpoint_id                    = aws_lb.ireland.arn
    weight                         = 100
    client_ip_preservation_enabled = false
  }
}
```

**`labs/ans-26-edge/terraform/cdn.tf`**
```hcl
# cdn.tf
#
# Plain English: lab 26's CloudFront distribution (Europe and North America
# edges only, PriceClass_100; A66). Two origins, the London and the Ireland
# NLBs on plain HTTP port 80, joined in an origin group: London first, and
# Ireland whenever London answers 500, 502, 503 or 504 or cannot be reached
# (one connection attempt, a 3-second timeout, so the failover is quick).
# Nothing is cached (AWS's managed CachingDisabled policy, as lab 09 names
# it), so every request shows which site answered. A CloudFront Function,
# lab-<id>-headers (owned by its name, A4), adds the header
# x-cloudlabs-edge: cloudfront to every request on its way in, and the web
# ACL in waf.tf screens every request first. Deleting the distribution
# disables it everywhere first: destroy_min 15.

locals {
  # AWS's managed cache policy (the same id in every account, as lab 09 uses it).
  caching_disabled = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
}

resource "aws_cloudfront_function" "headers" {
  name    = "lab-${var.lab_id}-headers"
  runtime = "cloudfront-js-2.0"
  comment = "lab ${var.lab_id}: marks each request that came through CloudFront"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      request.headers['x-cloudlabs-edge'] = { value: 'cloudfront' };
      return request;
    }
  EOT
}

resource "aws_cloudfront_distribution" "lab" {
  enabled             = true
  comment             = "lab ${var.lab_id}"
  price_class         = "PriceClass_100"
  retain_on_delete    = false
  wait_for_deployment = true
  web_acl_id          = aws_wafv2_web_acl.lab.arn

  origin {
    origin_id           = "london"
    domain_name         = aws_lb.london.dns_name
    connection_attempts = 1
    connection_timeout  = 3
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    origin_id   = "ireland"
    domain_name = aws_lb.ireland.dns_name
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin_group {
    origin_id = "failover"
    failover_criteria {
      status_codes = [500, 502, 503, 504]
    }
    member {
      origin_id = "london"
    }
    member {
      origin_id = "ireland"
    }
  }

  default_cache_behavior {
    target_origin_id       = "failover"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.caching_disabled
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.headers.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "cdn-lab" }
}
```

**`labs/ans-26-edge/terraform/waf.tf`**
```hcl
# waf.tf
#
# Plain English: lab 26's WAF web ACL, lab-<id>-waf, for CloudFront, so it
# lives in us-east-1 (this resource's own region; no third provider block,
# ruling P9). It allows by default and has two rules: AWS's managed Core rule
# set (common attacks such as cross-site scripting in a query string,
# blocked), and a rate-based rule that blocks any one address sending more
# than 100 requests in 5 minutes. AWS's paid rule groups (Bot Control,
# account takeover and creation fraud, Anti-DDoS) are never used here.
# Metrics and sampled requests are on, so the WAF console shows what it did.

resource "aws_wafv2_web_acl" "lab" {
  region      = "us-east-1"
  name        = "lab-${var.lab_id}-waf"
  description = "lab ${var.lab_id}: the CloudFront distribution's web ACL"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "common"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "lab-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate"
    priority = 2
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit                 = 100
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "lab-rate"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "lab-waf"
    sampled_requests_enabled   = true
  }

  tags = { Name = "waf-lab" }
}
```

**`labs/ans-26-edge/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 26 is up: the two
# instances' addresses, console SSH to each (Ireland's needs its region), and
# the three ways in: Global Accelerator's first static address, CloudFront's
# name, and each NLB directly. Lab 26 never peers (connectivity off), so it
# names no route tables for the VPN server's route.

output "private_ips" {
  value = { "vm-london" = aws_instance.london.private_ip, "vm-ireland" = aws_instance.ireland.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.london.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --region ${var.secondary_region} --instance-id ${aws_instance.ireland.id} --os-user labadmin --connection-type eice",
    "Global Accelerator: curl http://${aws_globalaccelerator_accelerator.lab.ip_sets[0].ip_addresses[0]}/",
    "CloudFront: curl -I https://${aws_cloudfront_distribution.lab.domain_name}/",
    "NLBs directly: curl http://${aws_lb.london.dns_name}/ and curl http://${aws_lb.ireland.dns_name}/",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = []
}
```

**`labs/ans-26-edge/readme.md`** (exactly):
````markdown
The edge of AWS's network, used two ways to reach the same small site in London and Ireland. CloudFront caches nothing here, but it ends HTTPS at its edge locations, runs a CloudFront Function on every request, screens each one with a WAF web ACL, and fails over from London to Ireland on its own. Global Accelerator gives you two fixed anycast addresses: you enter AWS at the nearest edge and ride AWS's own network to the nearest healthy region. Everything is listed in the lab's resource groups, `lab-ans-26-edge`, in AWS Resource Groups (London and Ireland); the web ACL is in us-east-1 and the accelerator in us-west-2, as their services require.
From the ANS-C01 outline: design edge networking with CloudFront and Global Accelerator, and protect it with AWS WAF.

## What it deploys

- **London**: `vm-london` (t4g.nano, a page saying "vm-london in eu-west-2 (London)") in `snet-private-1` of `vpc-lab`, behind the internet-facing Network Load Balancer `nlb-<name prefix>-ldn` (Name `nlb-ldn`) in `snet-public-1`
- **Ireland**: `vm-ireland` (the same page, naming Ireland) in `vpc-ireland` (the slot's second /20), behind `nlb-<name prefix>-dub` (Name `nlb-dub`), with its own Instance Connect Endpoint `eice-ireland`
- **CloudFront**: the distribution `cdn-lab` with an origin group, London first and Ireland on failure (500, 502, 503, 504, or no connection), no caching, and the CloudFront Function `lab-ans-26-edge-headers`, which adds `x-cloudlabs-edge: cloudfront` to each request
- **WAF** (us-east-1): the web ACL `lab-ans-26-edge-waf` on the distribution, with AWS's managed Core rule set and a rate-based rule blocking any address over 100 requests in 5 minutes
- **Global Accelerator** (us-west-2): the accelerator `lab-ans-26-edge` with two static addresses, a TCP listener on port 80, and endpoint groups in London and Ireland, each holding that region's NLB

Neither instance has a public address; the NLBs carry the traffic in. CloudFront takes several minutes to deploy and longer to delete, so the lab takes up to 12 minutes to start and 15 to tear down. This lab never peers to the VPN server: everything in it is reached from the internet.

```text
lab-ans-26-edge
  you --HTTPS--> CloudFront cdn-lab [WAF lab-ans-26-edge-waf, function lab-ans-26-edge-headers]
                   --origin group: London first--> nlb-ldn --TCP 80--> vm-london (vpc-lab, London)
                   --on failure-----------------> nlb-dub --TCP 80--> vm-ireland (vpc-ireland, Ireland)
  you --TCP 80--> Global Accelerator (2 static anycast IPs) --nearest healthy group--> nlb-ldn or nlb-dub
  console SSH: eice-lab (London), eice-ireland (Ireland)
```

## Things to try

- Compare the ways in from CloudShell or your PC: `curl` each Connect line a few times. CloudFront and Global Accelerator both answer from London (you are nearest to it). `curl -s -o /dev/null -w '%{time_connect} %{time_total}\n'` against each shows where the connection is set up: at an edge location for both, at the load balancer for the NLBs.
- Fail London: connect to `vm-london` and run `sudo systemctl stop lab-web`. CloudFront's next request comes back from Ireland straight away (the origin group's failover). Global Accelerator moves to Ireland once the London NLB reports its target unhealthy, within a minute or so. Start it again with `sudo systemctl start lab-web` and watch both come back to London.
- Turn the dial instead: in the Global Accelerator console (it lives in us-west-2), open the accelerator, the listener, and the London endpoint group, and set its traffic dial to 0%. Every request now goes to Ireland though London is healthy: this is how you drain a region for maintenance. Set it back to 100%.
- Test the web ACL: `curl -s -o /dev/null -w '%{http_code}\n' "https://<the distribution's name>/?q=<script>alert(1)</script>"` gets 403 from the Core rule set. Then `for i in $(seq 150); do curl -s -o /dev/null -w '%{http_code}\n' https://<the distribution's name>/; done | sort | uniq -c`: after about 100 requests, and with a short delay while WAF counts, you get 403s until the 5-minute window passes. The WAF console (us-east-1, Global (CloudFront)) shows the sampled requests and which rule matched.
- See the function's header arrive: on `vm-london`, `sudo dnf install -y tcpdump && sudo tcpdump -A -n -i any tcp port 80 | grep -i x-cloudlabs-edge`, then request the distribution. Requests through Global Accelerator or the NLB directly carry no such header.

## Not built here

- **Shield Advanced**: AWS's paid DDoS protection with a response team and cost protection. It is a yearly subscription for the whole account, so a lab never turns it on; every CloudFront distribution and accelerator already has Shield Standard.

## Learn more

- [Optimize high availability with CloudFront origin failover](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html)
- [Customize at the edge with CloudFront Functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.html)
- [Baseline rule groups (the Core rule set)](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-baseline.html)
- [Using rate-based rule statements in AWS WAF](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html)
- [What is AWS Global Accelerator?](https://docs.aws.amazon.com/global-accelerator/latest/dg/what-is-global-accelerator.html)
- [Adjusting traffic flow with traffic dials](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-endpoint-groups-traffic-dial.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-26-edge` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-26-edge.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Reach one site in two regions through CloudFront and Global Accelerator, and see how each fails over and filters.
learn:
  - Fail a CloudFront origin group over from London to Ireland
  - Move Global Accelerator traffic with health and traffic dials
  - Block attacks and floods at the edge with a WAF web ACL
learning_min: 75
```

**The diagram** must contain: `resourceGroup lab-ans-26-edge · London` and `resourceGroup lab-ans-26-edge · Ireland`; `vnet vpc-lab` (London) with `subnet snet-private-1`, `snet-private-2`, `snet-public-1`; `vnet vpc-ireland` (Ireland) with `subnet snet-ireland-private`, `snet-ireland-public`; `internetGateway igw-lab`, `igw-ireland`; `loadBalancer nlb-ldn` with a `traffic` edge `TCP 80` to `vm vm-london`, and `nlb-dub` with `TCP 80` to `vm vm-ireland`; `trafficManager ga-lab` with `traffic` edges `eu-west-2` to `nlb-ldn` and `eu-west-1` to `nlb-dub`; `frontDoor cdn-lab` with `traffic` edges `origin` to `nlb-ldn` and `nlb-dub`; `wafPolicy waf-lab` with a `dependency` edge `protects` to `cdn-lab`; `routeTable rt-public` (a `dependency` edge `0.0.0.0/0` to `igw-lab`), `rt-ireland-public` (to `igw-ireland`), `rt-private`, `rt-ireland-private`; `nsg sg-web`, `sg-web-ireland`, `sg-eice`, `sg-eice-ireland`, `sg-vms`; `bastion eice-lab`, `eice-ireland`; `privateEndpoint vpce-s3`, `vpce-s3-ireland`. No node for the function, the listener or the endpoint groups (folded).

- [ ] **Step 1: Write the failing tests.** `scripts/test/labs-aws-ans-26.test.mjs`:

```js
// labs-aws-ans-26.test.mjs
//
// Plain English: lab ans-26-edge is the lab AWS labs spec §12.2 row 26
// describes, the only four-region lab: CloudFront with an origin group, a
// CloudFront Function and a WAF web ACL (us-east-1), and Global Accelerator
// (us-west-2) to Network Load Balancers in London and Ireland, never to
// instances (rulings P1, P9, P10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { AWS_GA_LABS, AWS_GLOBAL_LABS, AWS_PEER_REGION_LABS, readsUsWest2, validateLearning } from "../lib/labs.mjs";

const ID = "ans-26-edge";
const block = (lab, type, name) => resources(lab, type).find((r) => r.labels[1] === name)?.body ?? "";

test("ans-26 keeps the AWS lab contract; it is a global and Global Accelerator lab with Ireland as its secondary region", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  const { yaml } = awsLab(ID);
  assert.deepEqual(yaml.regions, { secondary: "eu-west-1" });
  assert.ok(AWS_GLOBAL_LABS.includes(ID) && AWS_GA_LABS.includes(ID) && readsUsWest2(ID));
  assert.ok(!AWS_PEER_REGION_LABS.includes(ID));
});

test("ans-26's lab.yaml: §12.2 row 26, after soa-09, never peered, two /20s, about £0.08/h with the fixed fee and NLBs billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.security", "soa.networking"], ["soa-09-route53-cloudfront"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 12, destroy_min: 15, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano"] });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.07 && total < 0.095, `about £0.08/h, got ${total}`);
  for (const n of ["Global Accelerator fixed fee ($0.025 an hour)", "Network Load Balancer, London, hourly", "Network Load Balancer, Ireland, hourly"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
  assert.equal(yaml.cost.items.filter((i) => i.region === "secondary").length, 4);
});

test("ruling P9: two provider blocks only (§4's default and secondary); the ACL's own region is us-east-1; no region written as us-west-2", () => {
  const { files, tf, lab } = awsLab(ID);
  assert.equal([...tf.matchAll(/^provider "aws" \{/gm)].length, 2);
  assert.match(files["ireland.tf"], /provider "aws" \{\n  alias  = "secondary"\n  region = var\.secondary_region\n  default_tags \{\n    tags = var\.tags\n  \}\n\}/);
  const waf = block(lab, "aws_wafv2_web_acl", "lab");
  for (const re of [/region\s+= "us-east-1"/, /scope\s+= "CLOUDFRONT"/, /name\s+= "lab-\$\{var\.lab_id\}-waf"/]) assert.match(waf, re);
  assert.doesNotMatch(tf, /"us-west-2"/, "Global Accelerator goes through the default provider");
  assert.equal([...tf.matchAll(/region\s+= "us-east-1"/g)].length, 1, "only the web ACL names us-east-1");
});

test("ruling P9: Global Accelerator fronts the two lab NLBs, never instances, with client IP preservation off and flow logs off", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(block(lab, "aws_globalaccelerator_accelerator", "lab"), /flow_logs_enabled = false/);
  const groups = { london: ["var.region", "aws_lb.london.arn"], ireland: ["var.secondary_region", "aws_lb.ireland.arn"] };
  for (const [g, [region, lb]] of Object.entries(groups)) {
    const body = block(lab, "aws_globalaccelerator_endpoint_group", g);
    assert.match(body, new RegExp(`endpoint_group_region\\s+= ${region.replace(".", "\\.")}\\n`), g);
    assert.match(body, new RegExp(`endpoint_id\\s+= ${lb.replace(/\./g, "\\.")}\\n`), g);
    assert.match(body, /client_ip_preservation_enabled = false/, g);
  }
  assert.doesNotMatch(tf, /endpoint_id\s+= aws_instance\./);
  for (const lb of ["london", "ireland"]) {
    const body = block(lab, "aws_lb", lb);
    assert.match(body, /load_balancer_type\s+= "network"/);
    assert.match(body, /internal\s+= false/);
    assert.doesNotMatch(body, /security_groups/, `${lb}: no security group (P9)`);
  }
  assert.doesNotMatch(tf, /associate_public_ip_address|aws_eip"/);
});

test("CloudFront: an origin group London then Ireland on 500/502/503/504, the lab's function on viewer requests, the lab's ACL, PriceClass_100", () => {
  const { lab } = awsLab(ID);
  const cdn = block(lab, "aws_cloudfront_distribution", "lab");
  for (const re of [/price_class\s+= "PriceClass_100"/, /retain_on_delete\s+= false/, /web_acl_id\s+= aws_wafv2_web_acl\.lab\.arn/, /domain_name\s+= aws_lb\.london\.dns_name/, /domain_name = aws_lb\.ireland\.dns_name/, /status_codes = \[500, 502, 503, 504\]/, /target_origin_id\s+= "failover"/, /event_type\s+= "viewer-request"\n\s+function_arn = aws_cloudfront_function\.headers\.arn/, /cache_policy_id\s+= local\.caching_disabled/]) assert.match(cdn, re);
  assert.doesNotMatch(cdn, /lambda_function_association|logging_config/);
  const fn = block(lab, "aws_cloudfront_function", "headers");
  for (const re of [/name\s+= "lab-\$\{var\.lab_id\}-headers"/, /runtime = "cloudfront-js-2\.0"/, /publish = true/, /x-cloudlabs-edge/]) assert.match(fn, re);
});

test("ruling P9: the web ACL holds AWS's Core rule set and one rate rule, no paid group", () => {
  const { lab } = awsLab(ID);
  const waf = block(lab, "aws_wafv2_web_acl", "lab");
  assert.equal([...waf.matchAll(/^\s+rule \{/gm)].length, 2);
  for (const re of [/name\s+= "AWSManagedRulesCommonRuleSet"\n\s+vendor_name = "AWS"/, /limit\s+= 100/, /aggregate_key_type\s+= "IP"/]) assert.match(waf, re);
  assert.doesNotMatch(waf, /BotControl|ATP|ACFP|AntiDDoS/);
});

test("ans-26's Ireland: its own resource group and VPC in the slot's second /20, the instance on the Ireland AMI parameter", () => {
  const { lab, tf } = awsLab(ID);
  for (const re of [/resource "aws_resourcegroups_group" "secondary" \{\n  provider = aws\.secondary/, /ireland_vpc_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/]) assert.match(tf, re);
  const vm = block(lab, "aws_instance", "ireland");
  assert.match(vm, /provider\s+= aws\.secondary\n\s+ami\s+= data\.aws_ssm_parameter\.al2023_ireland\.insecure_value/);
  assert.deepEqual(resources(lab, "aws_ec2_instance_connect_endpoint").map((r) => r.labels[1]).sort(), ["ireland", "lab"], "two Instance Connect Endpoints, one per region");
});

test("ans-26's readme names every edge piece and Shield Advanced as not built; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["lab-ans-26-edge-waf", "lab-ans-26-edge-headers", "x-cloudlabs-edge", "traffic dial", "origin group", "us-west-2", "## Not built here", "Shield Advanced"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/labs-aws-ans-26.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged from `labs/_template-aws/`; trim `variables.tf` to the eight variables named; `terraform fmt -check` clean where terraform is installed.

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/ans-26-edge.mjs` (header comment in the house form): `c = ctxAws("ans-26-edge", "26")`; `variables: { ...c.variables, secondary_region: AWS_SECONDARY }`; `providers: ["aws"]`; `providerConfig: { ...AWS_PROVIDER_CONFIG, "aws.secondary": <the secondary configuration exactly as saa-16's fixture writes SECONDARY_PROVIDER_CONFIG> }`; `data: [...awsData(), data.aws_availability_zones.ireland (providerKey "aws.secondary"; names eu-west-1a, b, c; args ["state"]), data.aws_ssm_parameter.al2023_ireland (providerKey "aws.secondary"; values { name: the AL2023 parameter, insecure_value: "ami-0fedcba9876543210" }; args ["name"])]`; resources in file order:
  - `...templateResources(c)`.
  - **london.tf**: `aws_subnet.public` (known `cidrsubnet(c.vpcCidr, 4, 2)`, `eu-west-2a`, `map_public_ip_on_launch: false`, Name `snet-public-1`; unknown `vpc_id`; refs `cidr_block: ["local.vpc_cidr"]`, `availability_zone: ["local.azs[0]", "local.azs"]`); `aws_internet_gateway.lab`; `aws_route_table.public`; `aws_route.public_internet` (known `"0.0.0.0/0"`; unknown `route_table_id`, `gateway_id`); `aws_route_table_association.public`; `aws_security_group.web` and `web_http` (known `cidr_ipv4: "0.0.0.0/0"`, TCP 80), `web_ssh` (unknown `referenced_security_group_id` → `aws_security_group.eice.id`), `web_all`; `al2023Instance(c, { key: "london", name: "vm-london", type: "t4g.nano", sgs: ["aws_security_group.web"] })` with `refs.user_data = ["local.london_cloud_init"]`; `aws_lb.london` (known `name: "nlb-a26k3x9q-ldn"`, `internal: false`, `load_balancer_type: "network"`, `enable_deletion_protection: false`, Name `nlb-ldn`; unknown `subnets` → `aws_subnet.public.id`; no `security_groups`); `aws_lb_target_group.london` (known `tg-a26k3x9q-ldn`, 80, TCP; unknown `vpc_id`); the attachment (known `port: 80`; unknown → `aws_lb_target_group.london.arn`, `aws_instance.london.id`); `aws_lb_listener.london` (known 80 TCP, `default_action: [{ type: "forward" }]`; unknown `load_balancer_arn`, `default_action.0.target_group_arn`).
  - **ireland.tf**, every resource with `providerKey: "aws.secondary"` (so planned in eu-west-1): `aws_resourcegroups_group.secondary` (as the template's group); `aws_vpc.ireland` (known `cidrsubnet(c.address, 2, 1)`, Name `vpc-ireland`; ref `local.ireland_vpc_cidr`); `aws_subnet.ireland_private`, `.ireland_public` (known `/24`s 0 and 1 of it, `eu-west-1a`; refs `data.aws_availability_zones.ireland.names[0]`); `aws_internet_gateway.ireland`; the two route tables; `aws_route.ireland_public_internet`; the two associations; `aws_vpc_endpoint.ireland_s3` (known `com.amazonaws.eu-west-1.s3`, Gateway; ref `var.secondary_region`; unknown `route_table_ids` → `aws_route_table.ireland_private.id`); `aws_security_group.ireland_eice` and its egress (known the Ireland `/20`); `aws_ec2_instance_connect_endpoint.ireland` (unknown `subnet_id`, `security_group_ids.0`); `aws_security_group.ireland_web` and its three rules; `aws_instance.ireland` (built with `al2023Instance(c, { key: "ireland", name: "vm-ireland", type: "t4g.nano", subnet: "aws_subnet.ireland_private", sgs: ["aws_security_group.ireland_web"] })`, then `providerKey: "aws.secondary"`, `values.ami: "ami-0fedcba9876543210"`, `refs.ami: ["data.aws_ssm_parameter.al2023_ireland.insecure_value", "data.aws_ssm_parameter.al2023_ireland"]`, `refs.user_data: ["local.ireland_cloud_init"]`); `aws_lb.ireland` (known `nlb-a26k3x9q-dub`, Name `nlb-dub`, as London's), `aws_lb_target_group.ireland`, its attachment and listener.
  - **accelerator.tf** (default provider; Global Accelerator resources have no `region` attribute): `aws_globalaccelerator_accelerator.lab` (known `name: "lab-ans-26-edge"`, `ip_address_type: "IPV4"`, `enabled: true`, `attributes: [{ flow_logs_enabled: false }]`, Name `ga-lab`; `ip_sets`, `dns_name` computed); `aws_globalaccelerator_listener.http` (known `client_affinity: "NONE"`, `protocol: "TCP"`, `port_range: [{ from_port: 80, to_port: 80 }]`; unknown `accelerator_arn` → `aws_globalaccelerator_accelerator.lab.arn`); `aws_globalaccelerator_endpoint_group.london`, `.ireland` (known `endpoint_group_region` `eu-west-2` / `eu-west-1` with refs `var.region` / `var.secondary_region`, `health_check_protocol: "TCP"`, `health_check_port: 80`, `traffic_dial_percentage: 100`, `endpoint_configuration: [{ weight: 100, client_ip_preservation_enabled: false }]`; unknown `listener_arn` → the listener's `arn`, `endpoint_configuration.0.endpoint_id` → `aws_lb.london.arn` / `aws_lb.ireland.arn`).
  - **cdn.tf**: `aws_cloudfront_function.headers` (known `name: "lab-ans-26-edge-headers"`, `runtime`, `comment`, `publish: true`, `code`; `arn`, `etag` computed; no tags: untaggable, owned by name); `aws_cloudfront_distribution.lab` (known `enabled`, `comment`, `price_class: "PriceClass_100"`, `retain_on_delete: false`, `wait_for_deployment: true`, `origin: [{ origin_id: "london", connection_attempts: 1, connection_timeout: 3, custom_origin_config: [...] }, { origin_id: "ireland", custom_origin_config: [...] }]`, `origin_group: [{ origin_id: "failover", failover_criteria: [{ status_codes: [500, 502, 503, 504] }], member: [{ origin_id: "london" }, { origin_id: "ireland" }] }]`, `default_cache_behavior: [{ target_origin_id: "failover", viewer_protocol_policy: "redirect-to-https", allowed_methods, cached_methods, cache_policy_id: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", function_association: [{ event_type: "viewer-request" }] }]`, restrictions, viewer certificate, Name `cdn-lab`; unknown `origin.0.domain_name` → `aws_lb.london.dns_name`, `origin.1.domain_name` → `aws_lb.ireland.dns_name`, `default_cache_behavior.0.function_association.0.function_arn` → `aws_cloudfront_function.headers.arn`, `web_acl_id` → `aws_wafv2_web_acl.lab.arn`; ref `default_cache_behavior.0.cache_policy_id: ["local.caching_disabled"]`).
  - **waf.tf**: `aws_wafv2_web_acl.lab` (known `region: "us-east-1"` (configured, a constant), `name: "lab-ans-26-edge-waf"`, `scope: "CLOUDFRONT"`, `default_action: [{ allow: [{}] }]`, the two `rule` blocks as written (statements, `override_action`/`action`, `visibility_config`), the ACL's `visibility_config`, Name `waf-lab`; `arn`, `id`, `lock_token`, `capacity` computed).
  `lab-plans.test.mjs` proves it, the scope check included (rule 1: the ACL's own region on `GLOBAL_REGION_TYPES`, the endpoint group's region a lab region; Task 4's endpoint-group, ACL and distribution clauses).

- [ ] **Step 5: Generate the planned graph and the readme diagram**, read them against the diagram list above, add `GOLDEN["ans-26-edge"]` and the id to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-26.test.mjs scripts/test/labs-aws-template.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-26-edge`, `npm run labs-topology -- --check ans-26-edge`, `npm run labs-diagrams -- --check`
Expected: all PASS (labs-tf's mock plan sets `secondary_region`, so the secondary provider passes; the ACL's `region` is a constant).

- [ ] **Step 7: Commit**

```bash
git add labs/ans-26-edge labs/_learning/ans-26-edge.yaml shared/topology/planned/ans-26-edge.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-26 edge: CloudFront origin failover, a function and WAF, Global Accelerator to NLBs in London and Ireland

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 18: Lab ans-27-network-firewall

Spec: §12.2 row 27 (security, design; expert; explore; £££ 0.46; peering optional; 15/15; 2/3; prerequisite 21; TGW in appliance mode, inspection VPC with Network Firewall (one AZ), stateful and stateless rule groups, 2 spokes, NAT) and "Not built here" (Firewall Manager); §4 (a NAT gateway where the lab needs general internet); §5.1 (Network Firewall `READY`, transit gateways and attachments `available`); §7.3 (one subnet mapping); rulings A20, A45, A57, P8, P15, P16, P21.

**Files:**
- Create: `labs/ans-27-network-firewall/lab.yaml`, `readme.md`
- Create: `labs/ans-27-network-firewall/terraform/versions.tf`, `main.tf`, `network.tf` (all three copied unchanged from `labs/_template-aws/`), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`, each block exactly as the template writes it), `spoke-b.tf`, `inspection.tf`, `tgw.tf`, `firewall.tf`, `logs.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/ans-27-network-firewall.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-27-network-firewall.mjs`
- Create (generated): `shared/topology/planned/ans-27-network-firewall.json`, `shared/guides/ans-27-network-firewall/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-ans-27.test.mjs`

**Interfaces:**
- Consumes: the template network (`vpc-lab` is spoke A); Task 2 (`network-firewall:CreateFirewall*`, `CreateRuleGroup` create-listed, `UpdateLoggingConfiguration` change-listed after P21's wait; `logs:PutResourcePolicy` denied, so the bucket policy is the lab's own; `transitgateway` and `network-firewall` service-linked roles made ahead); Task 3 (the transit gateway and Network Firewall types on `AWS_TYPES`; P7's source clause on the bucket policy); Task 4 (`batch4Problems`: attachments, route tables, associations, propagations and routes all the lab's own by reference, `appliance_mode_support` on a lab attachment, at most 4 VPC attachments; one subnet mapping, protections off, capacity at most 100, no TLS inspection, logs to S3 only; rule 10's `vpc_endpoint_id` built from the lab's own firewall's `firewall_status`); Task 6 (firewall deleted and waited for, then the policy and groups; attachments, route tables, then the transit gateway; the ready check's `READY`); Task 10 (`transitGateway` with attachment edges, `firewall` in its subnet, `firewallPolicy` with a `policy` edge, rule groups folded).
- Produces: nothing other tasks call.

**`labs/ans-27-network-firewall/lab.yaml`**
```yaml
# Lab ans-27 (AWS labs batch 4). ANS-C01 ((V) the wording against the current
# exam guide): Network Security, Compliance, and Governance (AWS Network
# Firewall: stateless and stateful rule groups, a domain allow-list, alert
# logs); Network Design (centralised inspection through a transit gateway in
# appliance mode).
# London list prices × 0.75 (labs-verify --aws-prices); the firewall
# endpoint, the transit gateway attachments and the NAT gateway bill each
# started hour whole (V, A20). The firewall's and the attachments' filters
# are (V, Task 23). AWS waives a NAT gateway's hourly charge for each firewall
# endpoint hour (V): the estimate keeps the NAT item either way. Traffic
# processed is authored for light test traffic. This is the batch's dearest
# lab (one firewall endpoint, about 30p an hour): its session is 2 hours.
id: ans-27-network-firewall
version: 1
cloud: aws
title: "Network Firewall in an inspection VPC"
summary: >-
  Two spoke VPCs and an inspection VPC joined by a transit gateway in appliance mode, so every packet between the
  spokes and to the internet passes AWS Network Firewall: a stateless rule that drops ping between the spokes, a
  stateful domain allow-list, and alert logs in the lab's own bucket.
exam: ANS-C01
skill_areas: [ans.security, ans.design]
level: expert
type: explore
prerequisites: [ans-21-transit-gateway]
cost:
  items:
    - name: "Network Firewall endpoint, one AZ"
      gbp_h: 0.2963
      whole_hours: true
      aws_price: { service: AWSNetworkFirewall, unit: Hrs, filters: { usagetype: "{usage}-Endpoint-Hour" } }
    - { name: "Network Firewall traffic processed, light test traffic", gbp_h: 0.0010 }
    - name: "Transit gateway VPC attachments (2 spokes and the inspection VPC)"
      gbp_h: 0.0375
      qty: 3
      whole_hours: true
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { usagetype: "{usage}-TransitGateway-Hours" } }
    - name: "NAT gateway, hourly"
      gbp_h: 0.0375
      whole_hours: true
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { productFamily: "NAT Gateway", usagetype: "{usage}-NatGateway-Hours" } }
    - name: "Public IPv4 address (the NAT gateway's)"
      gbp_h: 0.0038
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - name: "EC2 t4g.nano, Linux (vm-a and vm-b)"
      gbp_h: 0.0035
      qty: 2
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 2
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "EC2 Instance Connect Endpoints (2)", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 15, destroy_min: 15, session_h: 2, max_h: 3 }
capacity: { instance_types: [t4g.nano, t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 3 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/ans-27-network-firewall/terraform/spoke-b.tf`**
```hcl
# spoke-b.tf
#
# Plain English: lab 27's second spoke, vpc-spoke-b (the slot's second /20;
# the template's vpc-lab is spoke A). Two private subnets in two zones, a
# route table whose only way out is the transit gateway (tgw.tf), a free S3
# gateway endpoint so vm-b installs packages without passing the firewall,
# and its own Instance Connect Endpoint for console SSH.

locals {
  spoke_b_cidr = cidrsubnet(var.address_space, 2, 1)
}

resource "aws_vpc" "spoke_b" {
  cidr_block           = local.spoke_b_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-spoke-b" }
}

resource "aws_subnet" "spoke_b" {
  count                   = 2
  vpc_id                  = aws_vpc.spoke_b.id
  cidr_block              = cidrsubnet(local.spoke_b_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-spoke-b-${count.index + 1}" }
}

resource "aws_route_table" "spoke_b" {
  vpc_id = aws_vpc.spoke_b.id
  tags   = { Name = "rt-spoke-b" }
}

resource "aws_route_table_association" "spoke_b" {
  count          = 2
  subnet_id      = aws_subnet.spoke_b[count.index].id
  route_table_id = aws_route_table.spoke_b.id
}

resource "aws_vpc_endpoint" "spoke_b_s3" {
  vpc_id            = aws_vpc.spoke_b.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.spoke_b.id]
  tags              = { Name = "vpce-s3-spoke-b" }
}

resource "aws_security_group" "spoke_b_eice" {
  name        = "lab-eice-spoke-b"
  description = "Instance Connect Endpoint in vpc-spoke-b: SSH out to vm-b"
  vpc_id      = aws_vpc.spoke_b.id
  tags        = { Name = "sg-eice-spoke-b" }
}

resource "aws_vpc_security_group_egress_rule" "spoke_b_eice_ssh" {
  security_group_id = aws_security_group.spoke_b_eice.id
  cidr_ipv4         = local.spoke_b_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "spoke_b" {
  subnet_id          = aws_subnet.spoke_b[0].id
  security_group_ids = [aws_security_group.spoke_b_eice.id]
  preserve_client_ip = false
  tags               = { Name = "eice-spoke-b" }
}
```

**`labs/ans-27-network-firewall/terraform/inspection.tf`**
```hcl
# inspection.tf
#
# Plain English: lab 27's inspection VPC, vpc-inspection (the slot's third
# /20), all in the first zone: snet-insp-tgw holds the transit gateway's
# attachment, snet-insp-firewall the firewall's endpoint, snet-insp-public
# the NAT gateway (and the internet gateway beyond it). The route tables
# make one path through the firewall for everything. From the transit
# gateway, every packet goes to the firewall endpoint. From the firewall's
# subnet, the internet is through the NAT gateway and the spokes (the slot)
# are back through the transit gateway. From the NAT gateway's subnet,
# replies for the spokes go through the firewall endpoint again, so the
# firewall sees both directions of every flow. The endpoint's id is read
# from the firewall's own status (local.fw_endpoint).

locals {
  insp_cidr   = cidrsubnet(var.address_space, 2, 2)
  fw_endpoint = one([for s in aws_networkfirewall_firewall.lab.firewall_status[0].sync_states : s.attachment[0].endpoint_id])
}

resource "aws_vpc" "inspection" {
  cidr_block           = local.insp_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-inspection" }
}

resource "aws_subnet" "insp_tgw" {
  vpc_id                  = aws_vpc.inspection.id
  cidr_block              = cidrsubnet(local.insp_cidr, 4, 0)
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-insp-tgw" }
}

resource "aws_subnet" "insp_firewall" {
  vpc_id                  = aws_vpc.inspection.id
  cidr_block              = cidrsubnet(local.insp_cidr, 4, 1)
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-insp-firewall" }
}

resource "aws_subnet" "insp_public" {
  vpc_id                  = aws_vpc.inspection.id
  cidr_block              = cidrsubnet(local.insp_cidr, 4, 2)
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-insp-public" }
}

resource "aws_internet_gateway" "inspection" {
  vpc_id = aws_vpc.inspection.id
  tags   = { Name = "igw-inspection" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat" }
}

resource "aws_nat_gateway" "inspection" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.insp_public.id
  tags          = { Name = "nat-inspection" }
  depends_on    = [aws_internet_gateway.inspection, aws_route.insp_public_default]
}

resource "aws_route_table" "insp_tgw" {
  vpc_id = aws_vpc.inspection.id
  tags   = { Name = "rt-insp-tgw" }
}

resource "aws_route_table" "insp_firewall" {
  vpc_id = aws_vpc.inspection.id
  tags   = { Name = "rt-insp-firewall" }
}

resource "aws_route_table" "insp_public" {
  vpc_id = aws_vpc.inspection.id
  tags   = { Name = "rt-insp-public" }
}

resource "aws_route" "insp_tgw_default" {
  route_table_id         = aws_route_table.insp_tgw.id
  destination_cidr_block = "0.0.0.0/0"
  vpc_endpoint_id        = local.fw_endpoint
}

resource "aws_route" "insp_firewall_default" {
  route_table_id         = aws_route_table.insp_firewall.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.inspection.id
}

resource "aws_route" "insp_firewall_slot" {
  route_table_id         = aws_route_table.insp_firewall.id
  destination_cidr_block = var.address_space
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.inspection]
}

resource "aws_route" "insp_public_default" {
  route_table_id         = aws_route_table.insp_public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.inspection.id
}

resource "aws_route" "insp_public_slot" {
  route_table_id         = aws_route_table.insp_public.id
  destination_cidr_block = var.address_space
  vpc_endpoint_id        = local.fw_endpoint
}

resource "aws_route_table_association" "insp_tgw" {
  subnet_id      = aws_subnet.insp_tgw.id
  route_table_id = aws_route_table.insp_tgw.id
}

resource "aws_route_table_association" "insp_firewall" {
  subnet_id      = aws_subnet.insp_firewall.id
  route_table_id = aws_route_table.insp_firewall.id
}

resource "aws_route_table_association" "insp_public" {
  subnet_id      = aws_subnet.insp_public.id
  route_table_id = aws_route_table.insp_public.id
}
```

**`labs/ans-27-network-firewall/terraform/tgw.tf`**
```hcl
# tgw.tf
#
# Plain English: lab 27's transit gateway, tgw-lab, with its default route
# tables switched off so every association is written here (ruling P15). The
# two spokes are associated with tgw-rt-spokes, whose only route sends
# everything (0.0.0.0/0) to the inspection VPC's attachment. The inspection
# attachment is associated with tgw-rt-inspection, which learns both spokes'
# ranges by propagation, so traffic the firewall passes finds its way back.
# Appliance mode on the inspection attachment keeps both directions of a
# flow in the same zone, so the firewall sees the whole conversation. Each
# spoke's own default route points at the transit gateway; the VPN server's
# more specific route, added when peered, still wins for its range.

resource "aws_ec2_transit_gateway" "lab" {
  description                     = "lab ${var.lab_id}: spokes through the inspection VPC"
  default_route_table_association = "disable"
  default_route_table_propagation = "disable"
  auto_accept_shared_attachments  = "disable"
  dns_support                     = "enable"
  tags                            = { Name = "tgw-lab" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "spoke_a" {
  transit_gateway_id                              = aws_ec2_transit_gateway.lab.id
  vpc_id                                          = aws_vpc.lab.id
  subnet_ids                                      = aws_subnet.private[*].id
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false
  tags                                            = { Name = "tgwa-spoke-a" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "spoke_b" {
  transit_gateway_id                              = aws_ec2_transit_gateway.lab.id
  vpc_id                                          = aws_vpc.spoke_b.id
  subnet_ids                                      = aws_subnet.spoke_b[*].id
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false
  tags                                            = { Name = "tgwa-spoke-b" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "inspection" {
  transit_gateway_id                              = aws_ec2_transit_gateway.lab.id
  vpc_id                                          = aws_vpc.inspection.id
  subnet_ids                                      = [aws_subnet.insp_tgw.id]
  appliance_mode_support                          = "enable"
  transit_gateway_default_route_table_association = false
  transit_gateway_default_route_table_propagation = false
  tags                                            = { Name = "tgwa-inspection" }
}

resource "aws_ec2_transit_gateway_route_table" "spokes" {
  transit_gateway_id = aws_ec2_transit_gateway.lab.id
  tags               = { Name = "tgw-rt-spokes" }
}

resource "aws_ec2_transit_gateway_route_table" "inspection" {
  transit_gateway_id = aws_ec2_transit_gateway.lab.id
  tags               = { Name = "tgw-rt-inspection" }
}

resource "aws_ec2_transit_gateway_route_table_association" "spoke_a" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_a.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_ec2_transit_gateway_route_table_association" "spoke_b" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_b.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_ec2_transit_gateway_route_table_association" "inspection" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.inspection.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.inspection.id
}

resource "aws_ec2_transit_gateway_route_table_propagation" "spoke_a" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_a.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.inspection.id
}

resource "aws_ec2_transit_gateway_route_table_propagation" "spoke_b" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.spoke_b.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.inspection.id
}

resource "aws_ec2_transit_gateway_route" "spokes_default" {
  destination_cidr_block         = "0.0.0.0/0"
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_vpc_attachment.inspection.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table.spokes.id
}

resource "aws_route" "private_tgw" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.spoke_a]
}

resource "aws_route" "spoke_b_tgw" {
  route_table_id         = aws_route_table.spoke_b.id
  destination_cidr_block = "0.0.0.0/0"
  transit_gateway_id     = aws_ec2_transit_gateway.lab.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.spoke_b]
}
```

**`labs/ans-27-network-firewall/terraform/firewall.tf`**
```hcl
# firewall.tf
#
# Plain English: lab 27's AWS Network Firewall, lab-<id>, with one endpoint
# in snet-insp-firewall (one zone keeps it to one endpoint-hour, about 30p;
# ruling P16), and no delete, subnet-change or policy-change protection, so
# tear-down can always remove it. Its policy, lab-<id>-policy, runs two rule
# groups in order. The stateless group drops ping (ICMP) from spoke B to
# spoke A and hands everything else to the stateful engine. The stateful
# group is a domain allow-list: HTTP host names and TLS server names ending
# .amazonaws.com, .amazon.com or .ubuntu.com, from the slot (HOME_NET) to
# anywhere outside it, pass. The rules are evaluated in strict order, and
# whatever no rule passes is dropped once its connection is set up, and
# logged as an alert (the lab's bucket, logs.tf). A 20-second wait lets the
# firewall's tags reach the permission check before its logging is set
# (ruling P21).

resource "aws_networkfirewall_rule_group" "stateless" {
  name        = "lab-${var.lab_id}-stateless"
  description = "Drop ping from spoke B to spoke A; send everything else to the stateful engine"
  type        = "STATELESS"
  capacity    = 10
  rule_group {
    rules_source {
      stateless_rules_and_custom_actions {
        stateless_rule {
          priority = 1
          rule_definition {
            actions = ["aws:drop"]
            match_attributes {
              protocols = [1]
              source {
                address_definition = local.spoke_b_cidr
              }
              destination {
                address_definition = local.vpc_cidr
              }
            }
          }
        }
        stateless_rule {
          priority = 10
          rule_definition {
            actions = ["aws:forward_to_sfe"]
            match_attributes {
              source {
                address_definition = "0.0.0.0/0"
              }
              destination {
                address_definition = "0.0.0.0/0"
              }
            }
          }
        }
      }
    }
  }
  tags = { Name = "nfw-stateless" }
}

resource "aws_networkfirewall_rule_group" "domains" {
  name        = "lab-${var.lab_id}-domains"
  description = "Allow HTTP and TLS only to AWS and Ubuntu domains"
  type        = "STATEFUL"
  capacity    = 100
  rule_group {
    rule_variables {
      ip_sets {
        key = "HOME_NET"
        ip_set {
          definition = [var.address_space]
        }
      }
    }
    rules_source {
      rules_source_list {
        generated_rules_type = "ALLOWLIST"
        target_types         = ["HTTP_HOST", "TLS_SNI"]
        targets              = [".amazonaws.com", ".amazon.com", ".ubuntu.com"]
      }
    }
    stateful_rule_options {
      rule_order = "STRICT_ORDER"
    }
  }
  tags = { Name = "nfw-domains" }
}

resource "aws_networkfirewall_firewall_policy" "lab" {
  name        = "lab-${var.lab_id}-policy"
  description = "lab ${var.lab_id}: the stateless group, then the domain allow-list, then drop established"
  firewall_policy {
    stateless_default_actions          = ["aws:forward_to_sfe"]
    stateless_fragment_default_actions = ["aws:forward_to_sfe"]
    stateful_default_actions           = ["aws:drop_established", "aws:alert_established"]
    stateless_rule_group_reference {
      priority     = 1
      resource_arn = aws_networkfirewall_rule_group.stateless.arn
    }
    stateful_engine_options {
      rule_order = "STRICT_ORDER"
    }
    stateful_rule_group_reference {
      priority     = 1
      resource_arn = aws_networkfirewall_rule_group.domains.arn
    }
  }
  tags = { Name = "nfw-policy" }
}

resource "aws_networkfirewall_firewall" "lab" {
  name                              = "lab-${var.lab_id}"
  description                       = "lab ${var.lab_id}: inspects the spokes through the transit gateway"
  firewall_policy_arn               = aws_networkfirewall_firewall_policy.lab.arn
  vpc_id                            = aws_vpc.inspection.id
  delete_protection                 = false
  subnet_change_protection          = false
  firewall_policy_change_protection = false
  subnet_mapping {
    subnet_id = aws_subnet.insp_firewall.id
  }
  tags = { Name = "nfw-lab" }
}

resource "time_sleep" "firewall_tags" {
  create_duration = "20s"
  depends_on      = [aws_networkfirewall_firewall.lab]
}
```

**`labs/ans-27-network-firewall/terraform/logs.tf`**
```hcl
# logs.tf
#
# Plain English: where lab 27's firewall writes its alerts: the lab's own
# bucket cloudlabs-<name_prefix>-nfwlogs, under alerts/ (ruling P8: vended
# logs go to the lab's bucket, never to CloudWatch Logs, whose delivery
# would write an account-wide policy). The bucket blocks every kind of
# public access, empties itself at tear-down, and lets only AWS's log
# delivery service write, for this account only (ruling P7). Each alert
# record names the flow, the domain and the action taken.

locals {
  nfw_bucket = "cloudlabs-${var.name_prefix}-nfwlogs"
  nfw_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-nfwlogs"
}

resource "aws_s3_bucket" "nfwlogs" {
  bucket        = local.nfw_bucket
  force_destroy = true
  tags          = { Name = "nfwlogs" }
}

resource "aws_s3_bucket_public_access_block" "nfwlogs" {
  bucket                  = aws_s3_bucket.nfwlogs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "nfwlogs" {
  bucket = aws_s3_bucket.nfwlogs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "LogDeliveryWrite"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${local.nfw_arn}/alerts/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
      {
        Sid       = "LogDeliveryAclCheck"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = local.nfw_arn
        Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.nfwlogs]
}

resource "aws_networkfirewall_logging_configuration" "lab" {
  firewall_arn = aws_networkfirewall_firewall.lab.arn
  logging_configuration {
    log_destination_config {
      log_destination = {
        bucketName = aws_s3_bucket.nfwlogs.bucket
        prefix     = "alerts"
      }
      log_destination_type = "S3"
      log_type             = "ALERT"
    }
  }
  depends_on = [time_sleep.firewall_tags, aws_s3_bucket_policy.nfwlogs]
}
```

**`labs/ans-27-network-firewall/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 27's two test instances, t4g.nano, each serving a page
# naming itself on port 80. vm-a sits in spoke A (snet-private-1, also in the
# template's sg-vms: SSH from the Instance Connect Endpoint, anything from
# the VPN server's range when peered). vm-b sits in spoke B (snet-spoke-b-1).
# Both admit ping and HTTP from anywhere in the lab's slot, so whatever stops
# them is the firewall, not a security group.

locals {
  web_unit = join("\n", [
    "[Unit]",
    "Description=Lab 27 page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  a_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-a in spoke A (vpc-lab)\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
  b_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-b in spoke B (vpc-spoke-b)\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_security_group" "vms_a" {
  name        = "lab-vms-a"
  description = "vm-a: ping and HTTP from the lab slot"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-vms-a" }
}

resource "aws_vpc_security_group_ingress_rule" "vms_a_ping" {
  security_group_id = aws_security_group.vms_a.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "vms_a_http" {
  security_group_id = aws_security_group.vms_a.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_security_group" "vms_b" {
  name        = "lab-vms-b"
  description = "vm-b: ping and HTTP from the lab slot, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.spoke_b.id
  tags        = { Name = "sg-vms-b" }
}

resource "aws_vpc_security_group_ingress_rule" "vms_b_ping" {
  security_group_id = aws_security_group.vms_b.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "vms_b_http" {
  security_group_id = aws_security_group.vms_b.id
  cidr_ipv4         = var.address_space
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "vms_b_ssh" {
  security_group_id            = aws_security_group.vms_b.id
  referenced_security_group_id = aws_security_group.spoke_b_eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "vms_b_all" {
  security_group_id = aws_security_group.vms_b.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "a" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.vms_a.id]
  user_data              = local.a_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-a" })
  tags        = { Name = "vm-a" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "b" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.spoke_b[0].id
  vpc_security_group_ids = [aws_security_group.vms_b.id]
  user_data              = local.b_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-b" })
  tags        = { Name = "vm-b" }
  depends_on  = [aws_vpc_endpoint.spoke_b_s3, aws_route_table_association.spoke_b]
}
```

**`labs/ans-27-network-firewall/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 27 is up: both
# instances' addresses, console SSH to each, the two tests to run on vm-a
# (one domain allowed, one dropped), where the alerts land, and, while
# peered, vm-a (spoke A is the hub).

output "private_ips" {
  value = { "vm-a" = aws_instance.a.private_ip, "vm-b" = aws_instance.b.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.a.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.b.id} --os-user labadmin --connection-type eice",
    "From vm-a: curl -sI --max-time 5 https://aws.amazon.com (allowed), curl -sI --max-time 5 https://example.com (dropped)",
    "aws s3 ls s3://${aws_s3_bucket.nfwlogs.bucket}/alerts/ --recursive",
    "ssh labadmin@${aws_instance.a.private_ip}",
    "curl http://${aws_instance.a.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/ans-27-network-firewall/readme.md`** (exactly):
````markdown
A hub-and-spoke network where nothing moves without passing a firewall. Two spoke VPCs and an inspection VPC hang off one transit gateway; the transit gateway sends every packet from a spoke, whether to the other spoke or to the internet, into the inspection VPC, where AWS Network Firewall decides. A stateless rule drops ping from spoke B to spoke A, a domain allow-list lets out only AWS and Ubuntu sites, and everything else is dropped and logged. Everything is listed in the lab's resource group, `lab-ans-27-network-firewall`, in AWS Resource Groups (London).
From the ANS-C01 outline: design and implement centralised traffic inspection with AWS Network Firewall and a transit gateway, and monitor it with firewall logs.

## What it deploys

- **Spoke A**: `vpc-lab` (the slot's first /20) with `vm-a` (t4g.nano, a page on port 80) in `snet-private-1`
- **Spoke B**: `vpc-spoke-b` (the second /20) with `vm-b` in `snet-spoke-b-1` and its own Instance Connect Endpoint `eice-spoke-b`
- **Inspection**: `vpc-inspection` (the third /20) with `snet-insp-tgw` (the transit gateway's side), `snet-insp-firewall` (the firewall's endpoint) and `snet-insp-public` (the NAT gateway `nat-inspection` and the internet gateway `igw-inspection`)
- **The transit gateway** `tgw-lab`: the spokes use `tgw-rt-spokes` (everything to the inspection VPC); the inspection attachment, in appliance mode, uses `tgw-rt-inspection` (both spokes' ranges, learned by propagation)
- **The firewall** `lab-ans-27-network-firewall` with its policy `lab-ans-27-network-firewall-policy`: the stateless group `lab-ans-27-network-firewall-stateless` (drop ICMP from spoke B to spoke A, send the rest on), then the stateful group `lab-ans-27-network-firewall-domains` (HTTP host and TLS server names ending `.amazonaws.com`, `.amazon.com` or `.ubuntu.com` pass), in strict order, with every other established flow dropped and logged
- **Alert logs** in the bucket `cloudlabs-<name prefix>-nfwlogs`, under `alerts/`

A firewall takes several minutes to create and to delete, so allow up to 15 minutes each way. One firewall endpoint costs about 30p an hour, which makes this the dearest lab of the batch. Sign in as `labadmin` with the password behind **Show**.

```text
lab-ans-27-network-firewall (London)
  vm-a (vpc-lab) ---0.0.0.0/0--> tgw-lab [tgw-rt-spokes: 0.0.0.0/0 -> tgwa-inspection]
  vm-b (vpc-spoke-b) --0.0.0.0/0-^
  tgwa-inspection (appliance mode) --> snet-insp-tgw --> firewall endpoint (snet-insp-firewall) [lab-ans-27-network-firewall]
      --> internet: nat-inspection --> igw-inspection     --> other spoke: back to tgw-lab [tgw-rt-inspection]
  replies from the internet: snet-insp-public --slot--> firewall endpoint --> tgw-lab --> the spoke
  alerts --> cloudlabs-<prefix>-nfwlogs/alerts/
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you (vm-a)
```

## Things to try

- On `vm-a` run the two `curl` lines from Connect: `https://aws.amazon.com` answers, `https://example.com` connects and then hangs until the timeout. The firewall let the TCP handshake through, read the TLS server name, found no rule passing it, and dropped the rest.
- Read the alerts a few minutes later (the firewall delivers logs every few minutes): the `aws s3 ls` line lists the files, and `aws s3 cp s3://<the bucket>/<a file's key> - | gunzip | head -5` shows records naming the source, the destination, `example.com` and the action, `blocked`.
- Between the spokes: on `vm-b`, `ping -c 3 <vm-a's address>` gets no answer, and the alert log never mentions it: the stateless rule dropped it before the stateful engine saw it, and stateless drops are not logged. `curl --max-time 5 http://<vm-a's address>` from `vm-b` fails too, but leaves an alert: the allow-list only passes named domains from the slot to outside it, and the policy drops everything else.
- Change the rules: in the VPC console, Network Firewall, Network Firewall rule groups, open `lab-ans-27-network-firewall-domains`, add `.example.com` to its domain list and save. A minute or so later the `example.com` line on `vm-a` answers.
- Read the routing that makes it work: in the VPC console, Transit gateway route tables, `tgw-rt-spokes` has one route (to the inspection attachment) and `tgw-rt-inspection` has both spokes' ranges. Then open `tgwa-inspection` and note appliance mode is on: without it, the two directions of a flow between spokes could reach the firewall in different zones and be dropped as half a conversation.

## Not built here

- **Firewall Manager**: applies Network Firewall, WAF and security group policies across every account of an organisation from one administrator account. It needs AWS Organizations and AWS Config across the organisation, which a lab in one account does not have.

## Learn more

- [What is AWS Network Firewall?](https://docs.aws.amazon.com/network-firewall/latest/developerguide/what-is-aws-network-firewall.html)
- [Stateful domain list rule groups](https://docs.aws.amazon.com/network-firewall/latest/developerguide/stateful-rule-groups-domain-names.html)
- [Evaluation order for stateful rules](https://docs.aws.amazon.com/network-firewall/latest/developerguide/suricata-rule-evaluation-order.html)
- [Stateful appliance in a shared services VPC](https://docs.aws.amazon.com/vpc/latest/tgw/transit-gateway-appliance-scenario.html)
- [Logging network traffic from AWS Network Firewall](https://docs.aws.amazon.com/network-firewall/latest/developerguide/firewall-logging.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-27-network-firewall` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-27-network-firewall.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Send every spoke's traffic through AWS Network Firewall in an inspection VPC and read what it allows, drops and logs.
learn:
  - Route spokes through an inspection VPC with transit gateway route tables and appliance mode
  - Combine a stateless drop rule with a stateful domain allow-list in strict order
  - Read the firewall's alert logs and change a rule group live
learning_min: 75
```

**The diagram** must contain: `resourceGroup lab-ans-27-network-firewall · London`; `vnet vpc-lab` with `subnet snet-private-1`, `snet-private-2`; `vnet vpc-spoke-b` with `subnet snet-spoke-b-1`, `snet-spoke-b-2`; `vnet vpc-inspection` with `subnet snet-insp-tgw`, `snet-insp-firewall`, `snet-insp-public`; `transitGateway tgw-lab` with `peering` edges `attachment` to `vpc-lab`, `vpc-spoke-b` and `vpc-inspection`; `firewall nfw-lab < snet-insp-firewall`; `firewallPolicy nfw-policy` with a `dependency` edge `policy` to `nfw-lab`; `natGateway nat-inspection`; `internetGateway igw-inspection`; `routeTable rt-private`, `rt-spoke-b`, `rt-insp-tgw`, `rt-insp-firewall` (a `dependency` edge `0.0.0.0/0` to `nat-inspection`), `rt-insp-public` (a `dependency` edge `0.0.0.0/0` to `igw-inspection`); `vm vm-a`, `vm vm-b`; `storage nfwlogs`; `nsg sg-vms-a`, `sg-vms-b`, `sg-vms`, `sg-eice`, `sg-eice-spoke-b`; `bastion eice-lab`, `eice-spoke-b`; `privateEndpoint vpce-s3`, `vpce-s3-spoke-b`. No node for the attachments, the transit gateway route tables, the rule groups, the logging configuration or the wait.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-ans-27.test.mjs`:

```js
// labs-aws-ans-27.test.mjs
//
// Plain English: lab ans-27-network-firewall is the lab AWS labs spec §12.2
// row 27 describes: two spokes and an inspection VPC on a transit gateway in
// appliance mode, a Network Firewall in one zone with a stateless and a
// stateful rule group, NAT in the inspection VPC, and alert logs in the
// lab's own bucket (rulings P8, P15, P16, P21).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-27-network-firewall";
const block = (lab, type, name) => resources(lab, type).find((r) => r.labels[1] === name)?.body ?? "";

test("ans-27 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-27's lab.yaml: §12.2 row 27, after ans-21, three /20s, about £0.46/h with the firewall, attachments and NAT billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.security", "ans.design"], ["ans-21-transit-gateway"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 15, destroy_min: 15, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 3 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano"] });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.43 && total < 0.49, `about £0.46/h, got ${total}`);
  for (const n of ["Network Firewall endpoint, one AZ", "Transit gateway VPC attachments (2 spokes and the inspection VPC)", "NAT gateway, hourly"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
});

test("ruling P15: the transit gateway's defaults are off; spokes go to the inspection attachment, which alone is in appliance mode and learns both spokes", () => {
  const { lab } = awsLab(ID);
  const tgw = block(lab, "aws_ec2_transit_gateway", "lab");
  for (const re of [/default_route_table_association = "disable"/, /default_route_table_propagation = "disable"/, /auto_accept_shared_attachments\s+= "disable"/]) assert.match(tgw, re);
  assert.deepEqual(resources(lab, "aws_ec2_transit_gateway_vpc_attachment").map((r) => r.labels[1]).sort(), ["inspection", "spoke_a", "spoke_b"]);
  assert.match(block(lab, "aws_ec2_transit_gateway_vpc_attachment", "inspection"), /appliance_mode_support\s+= "enable"/);
  for (const s of ["spoke_a", "spoke_b"]) assert.doesNotMatch(block(lab, "aws_ec2_transit_gateway_vpc_attachment", s), /appliance_mode_support/, s);
  for (const s of ["spoke_a", "spoke_b"]) assert.match(block(lab, "aws_ec2_transit_gateway_route_table_propagation", s), /transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table\.inspection\.id/, s);
  const r = block(lab, "aws_ec2_transit_gateway_route", "spokes_default");
  for (const re of [/destination_cidr_block\s+= "0\.0\.0\.0\/0"/, /transit_gateway_attachment_id\s+= aws_ec2_transit_gateway_vpc_attachment\.inspection\.id/, /transit_gateway_route_table_id = aws_ec2_transit_gateway_route_table\.spokes\.id/]) assert.match(r, re);
});

test("the inspection VPC sends both directions through the firewall endpoint, read from the firewall's own status", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(tf, /fw_endpoint = one\(\[for s in aws_networkfirewall_firewall\.lab\.firewall_status\[0\]\.sync_states : s\.attachment\[0\]\.endpoint_id\]\)/);
  for (const r of ["insp_tgw_default", "insp_public_slot"]) assert.match(block(lab, "aws_route", r), /vpc_endpoint_id\s+= local\.fw_endpoint/, r);
  assert.match(block(lab, "aws_route", "insp_public_slot"), /destination_cidr_block = var\.address_space/);
  assert.match(block(lab, "aws_route", "insp_firewall_slot"), /transit_gateway_id\s+= aws_ec2_transit_gateway\.lab\.id/);
  assert.match(block(lab, "aws_route", "insp_firewall_default"), /nat_gateway_id\s+= aws_nat_gateway\.inspection\.id/);
  assert.equal([...tf.matchAll(/resource "aws_nat_gateway"/g)].length, 1);
});

test("ruling P16: one subnet mapping, no protections, capacities within 100, ICMP B to A dropped, a domain allow-list in strict order, drop established", () => {
  const { lab, tf } = awsLab(ID);
  const fw = block(lab, "aws_networkfirewall_firewall", "lab");
  assert.equal([...fw.matchAll(/subnet_mapping \{/g)].length, 1);
  for (const k of ["delete_protection", "subnet_change_protection", "firewall_policy_change_protection"]) assert.match(fw, new RegExp(`${k}\\s+= false`), k);
  for (const [g, cap] of [["stateless", 10], ["domains", 100]]) assert.match(block(lab, "aws_networkfirewall_rule_group", g), new RegExp(`capacity\\s+= ${cap}\\n`), g);
  const sl = block(lab, "aws_networkfirewall_rule_group", "stateless");
  for (const re of [/actions = \["aws:drop"\][\s\S]*protocols = \[1\][\s\S]*address_definition = local\.spoke_b_cidr[\s\S]*address_definition = local\.vpc_cidr/, /actions = \["aws:forward_to_sfe"\]/]) assert.match(sl, re);
  const dl = block(lab, "aws_networkfirewall_rule_group", "domains");
  for (const re of [/generated_rules_type = "ALLOWLIST"/, /target_types\s+= \["HTTP_HOST", "TLS_SNI"\]/, /targets\s+= \["\.amazonaws\.com", "\.amazon\.com", "\.ubuntu\.com"\]/, /key = "HOME_NET"/, /definition = \[var\.address_space\]/, /rule_order = "STRICT_ORDER"/]) assert.match(dl, re);
  const pol = block(lab, "aws_networkfirewall_firewall_policy", "lab");
  for (const re of [/stateful_default_actions\s+= \["aws:drop_established", "aws:alert_established"\]/, /rule_order = "STRICT_ORDER"/, /resource_arn = aws_networkfirewall_rule_group\.stateless\.arn/, /resource_arn = aws_networkfirewall_rule_group\.domains\.arn/]) assert.match(pol, re);
  assert.doesNotMatch(tf, /tls_inspection_configuration/);
});

test("rulings P8 and P21: alerts go to the lab's bucket through an explicit policy naming this account, after a 20-second wait", () => {
  const { lab } = awsLab(ID);
  const log = block(lab, "aws_networkfirewall_logging_configuration", "lab");
  for (const re of [/log_destination_type = "S3"/, /log_type\s+= "ALERT"/, /bucketName = aws_s3_bucket\.nfwlogs\.bucket/, /prefix\s+= "alerts"/, /depends_on = \[time_sleep\.firewall_tags, aws_s3_bucket_policy\.nfwlogs\]/]) assert.match(log, re);
  assert.doesNotMatch(log, /CloudWatchLogs|KinesisDataFirehose/);
  assert.match(block(lab, "time_sleep", "firewall_tags"), /create_duration = "20s"/);
  const pol = block(lab, "aws_s3_bucket_policy", "nfwlogs");
  assert.equal([...pol.matchAll(/"aws:SourceAccount" = data\.aws_caller_identity\.current\.account_id/g)].length, 2);
  assert.match(pol, /Principal = \{ Service = "delivery\.logs\.amazonaws\.com" \}/);
  assert.match(block(lab, "aws_s3_bucket", "nfwlogs"), /bucket\s+= local\.nfw_bucket/);
});

test("ans-27's readme names the path, the groups and Firewall Manager as not built; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["tgw-rt-spokes", "tgw-rt-inspection", "appliance mode", "lab-ans-27-network-firewall-domains", "example.com", "alerts/", "## Not built here", "Firewall Manager"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-ans-27.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged from `labs/_template-aws/`; trim `variables.tf` to the seven variables named; `terraform fmt -check` clean where terraform is installed.

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/ans-27-network-firewall.mjs` (header comment in the house form): `c = ctxAws("ans-27-network-firewall", "27")`; `variables: c.variables`; `providers: ["aws"]`; `providerConfig: AWS_PROVIDER_CONFIG`; `data: awsData()`; with `spokeB = cidrsubnet(c.address, 2, 1)`, `insp = cidrsubnet(c.address, 2, 2)`, resources in file order:
  - `...templateResources(c)`.
  - **spoke-b.tf**: `aws_vpc.spoke_b` (known `spokeB`, ref `local.spoke_b_cidr`, Name `vpc-spoke-b`); `aws_subnet.spoke_b[0]`, `[1]` (`count: 2`; known `cidrsubnet(spokeB, 4, i)`, `eu-west-2a`/`b`; unknown `vpc_id`; refs with `count.index`); `aws_route_table.spoke_b`; the two associations; `aws_vpc_endpoint.spoke_b_s3` (known service, Gateway; unknown `vpc_id`, `route_table_ids`); `aws_security_group.spoke_b_eice` and its egress (known `cidr_ipv4: spokeB`); `aws_ec2_instance_connect_endpoint.spoke_b` (unknown `subnet_id` → `aws_subnet.spoke_b[0]`, `security_group_ids.0`).
  - **inspection.tf**: `aws_vpc.inspection` (known `insp`); the three subnets (known `cidrsubnet(insp, 4, 0/1/2)`, `eu-west-2a`); `aws_internet_gateway.inspection`; `aws_eip.nat`; `aws_nat_gateway.inspection` (unknown `allocation_id`, `subnet_id` → `aws_subnet.insp_public.id`); the three route tables; the five routes: `insp_tgw_default` and `insp_public_slot` with unknown `vpc_endpoint_id` and refs `["local.fw_endpoint", "aws_networkfirewall_firewall.lab.firewall_status", "aws_networkfirewall_firewall.lab"]` (the attribute path Terraform is expected to print for the `for` expression: a drafted guess, no real plan read; Task 24 Step 8 recalibrates it from the recorded shape, and Task 4's `firewall_status` clause must accept whatever form Terraform prints, so the recalibration changes only this fixture), known destinations `"0.0.0.0/0"` and `c.address` (ref `var.address_space`); `insp_firewall_default` (unknown `nat_gateway_id` → `aws_nat_gateway.inspection.id`); `insp_firewall_slot` (known `c.address`; unknown `transit_gateway_id` → `aws_ec2_transit_gateway.lab.id`); `insp_public_default` (unknown `gateway_id`); the three associations.
  - **tgw.tf**: `aws_ec2_transit_gateway.lab` (known `description` (ref `var.lab_id`), the four `disable`/`enable` settings, Name `tgw-lab`); the three VPC attachments (known `transit_gateway_default_route_table_association: false`, `…_propagation: false`, Names, and `appliance_mode_support: "enable"` on `inspection` only; unknown `transit_gateway_id`, `vpc_id` → `aws_vpc.lab.id` / `aws_vpc.spoke_b.id` / `aws_vpc.inspection.id`, `subnet_ids` → `aws_subnet.private` / `aws_subnet.spoke_b` / `aws_subnet.insp_tgw.id`); the two route tables (unknown `transit_gateway_id`, Names `tgw-rt-spokes`, `tgw-rt-inspection`); the three associations and two propagations (both ids unknown with refs); `aws_ec2_transit_gateway_route.spokes_default` (known `"0.0.0.0/0"`; unknown `transit_gateway_attachment_id` → `…vpc_attachment.inspection.id`, `transit_gateway_route_table_id` → `…route_table.spokes.id`); `aws_route.private_tgw`, `aws_route.spoke_b_tgw` (known `"0.0.0.0/0"`; unknown `route_table_id`, `transit_gateway_id`).
  - **firewall.tf**: `aws_networkfirewall_rule_group.stateless` (known name, description, `type: "STATELESS"`, `capacity: 10`, Name; `rule_group` known except the first rule's `source.0.address_definition` and `destination.0.address_definition`, which are known too: `spokeB` and `c.vpcCidr` with refs `local.spoke_b_cidr`, `local.vpc_cidr`); `aws_networkfirewall_rule_group.domains` (known `type: "STATEFUL"`, `capacity: 100`, the `rule_variables` with `definition: [c.address]` (ref `var.address_space`), `rules_source_list`, `stateful_rule_options: [{ rule_order: "STRICT_ORDER" }]`); `aws_networkfirewall_firewall_policy.lab` (known name, the default actions, `stateful_engine_options`; unknown `firewall_policy.0.stateless_rule_group_reference.0.resource_arn` and `…stateful_rule_group_reference.0.resource_arn` with refs to the groups' `arn`); `aws_networkfirewall_firewall.lab` (known `name: "lab-ans-27-network-firewall"`, description, the three protections `false`, `subnet_mapping: [{}]`, Name `nfw-lab`; unknown `firewall_policy_arn`, `vpc_id`, `subnet_mapping.0.subnet_id`; `firewall_status` computed); `time_sleep.firewall_tags` (known `create_duration: "20s"`).
  - **logs.tf**: `aws_s3_bucket.nfwlogs` (known `bucket: "cloudlabs-a27k3x9q-nfwlogs"`, `force_destroy: true`, Name `nfwlogs`; ref `local.nfw_bucket`); its public access block (unknown `bucket`); `aws_s3_bucket_policy.nfwlogs` (unknown `bucket`; `policy` known at plan: the document above with the account `123456789012` and the bucket ARN, refs `local.nfw_arn` and `data.aws_caller_identity.current.account_id`); `aws_networkfirewall_logging_configuration.lab` (known `logging_configuration: [{ log_destination_config: [{ log_destination_type: "S3", log_type: "ALERT", log_destination: { prefix: "alerts" } }] }]` with `bucketName` unknown → `aws_s3_bucket.nfwlogs.bucket`; unknown `firewall_arn`).
  - **compute.tf**: `aws_security_group.vms_a`, `.vms_b` and their six rules (known `c.address` with ref `var.address_space`; ICMP `-1`; `vms_b_ssh`'s `referenced_security_group_id` → `aws_security_group.spoke_b_eice.id`); `al2023Instance(c, { key: "a", name: "vm-a", type: "t4g.nano", sgs: ["aws_security_group.vms", "aws_security_group.vms_a"] })` with `refs.user_data = ["local.a_cloud_init"]`; `al2023Instance(c, { key: "b", name: "vm-b", type: "t4g.nano", subnet: "aws_subnet.spoke_b[0]", sgs: ["aws_security_group.vms_b"] })` with `refs.user_data = ["local.b_cloud_init"]`.
  `lab-plans.test.mjs` proves it, the scope check included (rule 10 reads the two firewall-endpoint routes through Task 4's `firewall_status` clause).

- [ ] **Step 5: Generate the planned graph and the readme diagram**, read them against the diagram list above, add `GOLDEN["ans-27-network-firewall"]` and the id to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-27.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-27-network-firewall`, `npm run labs-topology -- --check ans-27-network-firewall`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/ans-27-network-firewall labs/_learning/ans-27-network-firewall.yaml shared/topology/planned/ans-27-network-firewall.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-27 Network Firewall in an inspection VPC behind a transit gateway in appliance mode

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 19: Lab ans-28-flow-logs-fix

Spec: §12.2 row 28 (operations, security, soa.networking; expert; break-fix; £ 0.05; peering optional; 6/5; 2/4; prerequisite 08; client and service VPCs, NLB, flow logs to CloudWatch and to S3 with an Athena table, traffic mirror target and filter) and its two faults, verbatim; §3.3 (Symptom, a closed What was broken); rulings A28, A56, A75, A82, A97, P7, P8, P17.

**Files:**
- Create: `labs/ans-28-flow-logs-fix/lab.yaml`, `readme.md`
- Create: `labs/ans-28-flow-logs-fix/terraform/versions.tf`, `main.tf`, `network.tf` (all three copied unchanged from `labs/_template-aws/`), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`, each block exactly as the template writes it), `service.tf`, `nlb.tf`, `acl.tf`, `flowlogs.tf`, `athena.tf`, `mirror.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/ans-28-flow-logs-fix.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-28-flow-logs-fix.mjs`
- Create (generated): `shared/topology/planned/ans-28-flow-logs-fix.json`, `shared/guides/ans-28-flow-logs-fix/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-ans-28.test.mjs`

**Interfaces:**
- Consumes: the template network (`vpc-lab` is the client VPC); soa-08's patterns, rewritten here for this lab (the NACL and its association, A82; the flow-log role with `aws:SourceAccount`); saa-17's Glue and Athena pattern (`lab_<id>`, `lab-<id>-wg`, A97); Task 2 (`ec2:CreateTrafficMirror{Target,Filter}` create-listed and `ec2:CreateTrafficMirrorFilterRule` create-tag exempt (P17: the provider's filter rule takes no tags); vended log delivery to the lab's bucket (`logs:CreateLogDelivery`, the bucket's own policy); `iam:PassRole` of `lab-<id>-flowlogs` to `vpc-flow-logs.amazonaws.com`; `logs:PutResourcePolicy` denied); Task 3 (`aws_ec2_traffic_mirror_*` and `aws_glue_catalog_table` on `AWS_TYPES`; P7's source clause); Task 4 (`batch4Problems`: the mirror target the lab's own instance's interface, filter rules inside the slot, the table's location in the lab's bucket and its database `lab_<id>`, an S3 flow log only to the lab's own bucket); Task 6 (mirror sessions, targets and filters deleted in phase 3, a hand-made tagged session first); Task 10 (`generic` mirror target with a `mirror to` edge, `generic` filter, the table folded into its database).
- Produces: nothing other tasks call.

**`labs/ans-28-flow-logs-fix/lab.yaml`**
```yaml
# Lab ans-28 (AWS labs batch 4), a break-fix lab. ANS-C01 ((V) the wording
# against the current exam guide): Network Management and Operation
# (troubleshooting with flow logs, Athena, Reachability Analyzer and Network
# Access Analyzer; traffic mirroring); Network Security, Compliance, and
# Governance (security groups and network ACLs behind a load balancer);
# SOA-C03 Networking and Content Delivery.
# The two faults are AWS labs spec §12.2's, verbatim (ruling A28, P17).
# London list prices × 0.75 (labs-verify --aws-prices); the NLB bills each
# started hour whole (V, A20; the NLB filter is V, Task 23). Authored: NLB
# capacity units and flow logs (a few MB) for light test traffic. The mirror
# target and filter cost nothing; a mirror session (made by hand, a Thing to
# try) is billed per source interface-hour, as are Athena per GB scanned and
# Reachability Analyzer per analysis (the readme says so beside each).
id: ans-28-flow-logs-fix
version: 1
cloud: aws
title: "Break-fix: flow logs, mirroring and analyzers"
summary: >-
  A client VPC peered to a service VPC with an internal Network Load Balancer in front of a web instance, and a
  client whose requests never get an answer while the target looks healthy. Find the two faults with VPC Flow Logs in
  CloudWatch and in S3 through Athena, traffic mirroring and the VPC analyzers, and fix them.
exam: ANS-C01
skill_areas: [ans.operations, ans.security, soa.networking]
level: expert
type: break-fix
prerequisites: [soa-08-vpc-fix]
cost:
  items:
    - name: "Network Load Balancer, hourly"
      gbp_h: 0.0198
      whole_hours: true
      aws_price: { service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Network", usagetype: "{usage}-LoadBalancerUsage" } }
    - { name: "NLB capacity units, light test traffic", gbp_h: 0.0045 }
    - name: "EC2 t4g.nano, Linux (vm-client, vm-svc, vm-monitor)"
      gbp_h: 0.0035
      qty: 3
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 3
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "Flow logs to CloudWatch and S3, a few MB", gbp_h: 0.0005 }
    - { name: "Traffic mirror target and filter (a session is billed per hour, by hand)", gbp_h: 0 }
    - { name: "EC2 Instance Connect Endpoints (2) and VPC peering in one AZ", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 6, destroy_min: 5, session_h: 2, max_h: 4 }
capacity: { instance_types: [t4g.nano, t4g.nano, t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 2 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`labs/ans-28-flow-logs-fix/terraform/service.tf`**
```hcl
# service.tf
#
# Plain English: lab 28's service VPC, vpc-service (the slot's second /20),
# peered to the client VPC (the template's vpc-lab) with a route on each
# side. Two subnets in the first zone: snet-nlb (the load balancer and the
# monitor instance) and snet-svc (the web instance, vm-svc). The service
# VPC's own Instance Connect Endpoint sits in snet-svc, beside vm-svc, so the
# subnet's network ACL never stands between them (ACLs filter only traffic
# entering or leaving a subnet; A75). A free S3 gateway endpoint serves
# packages.

locals {
  svc_vpc_cidr = cidrsubnet(var.address_space, 2, 1)
  nlb_cidr     = cidrsubnet(local.svc_vpc_cidr, 4, 0)
  svc_cidr     = cidrsubnet(local.svc_vpc_cidr, 4, 1)
}

resource "aws_vpc" "service" {
  cidr_block           = local.svc_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-service" }
}

resource "aws_subnet" "nlb" {
  vpc_id                  = aws_vpc.service.id
  cidr_block              = local.nlb_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-nlb" }
}

resource "aws_subnet" "svc" {
  vpc_id                  = aws_vpc.service.id
  cidr_block              = local.svc_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-svc" }
}

resource "aws_route_table" "service" {
  vpc_id = aws_vpc.service.id
  tags   = { Name = "rt-service" }
}

resource "aws_route_table_association" "nlb" {
  subnet_id      = aws_subnet.nlb.id
  route_table_id = aws_route_table.service.id
}

resource "aws_route_table_association" "svc" {
  subnet_id      = aws_subnet.svc.id
  route_table_id = aws_route_table.service.id
}

resource "aws_vpc_endpoint" "service_s3" {
  vpc_id            = aws_vpc.service.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.service.id]
  tags              = { Name = "vpce-s3-service" }
}

resource "aws_vpc_peering_connection" "client_service" {
  vpc_id      = aws_vpc.lab.id
  peer_vpc_id = aws_vpc.service.id
  auto_accept = true
  tags        = { Name = "pcx-client-service" }
}

resource "aws_route" "client_to_service" {
  route_table_id            = aws_route_table.private.id
  destination_cidr_block    = local.svc_vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.client_service.id
}

resource "aws_route" "service_to_client" {
  route_table_id            = aws_route_table.service.id
  destination_cidr_block    = local.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.client_service.id
}

resource "aws_security_group" "service_eice" {
  name        = "lab-eice-service"
  description = "Instance Connect Endpoint in vpc-service: SSH out to vm-svc and vm-monitor"
  vpc_id      = aws_vpc.service.id
  tags        = { Name = "sg-eice-service" }
}

resource "aws_vpc_security_group_egress_rule" "service_eice_ssh" {
  security_group_id = aws_security_group.service_eice.id
  cidr_ipv4         = local.svc_vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "service" {
  subnet_id          = aws_subnet.svc.id
  security_group_ids = [aws_security_group.service_eice.id]
  preserve_client_ip = false
  tags               = { Name = "eice-service" }
}
```

**`labs/ans-28-flow-logs-fix/terraform/nlb.tf`**
```hcl
# nlb.tf
#
# Plain English: lab 28's internal Network Load Balancer, nlb-<name_prefix>,
# in snet-nlb, with no security group: TCP 80 to vm-svc. Its target group
# keeps client IP preservation on, so vm-svc sees each request coming from
# the client's own address in vpc-lab, not from the load balancer. Health
# checks still come from the load balancer's own addresses in snet-nlb.
# THIS IS HALF OF FAULT 1 (readme, What was broken): the other half is
# vm-svc's security group, in compute.tf.

resource "aws_lb" "svc" {
  name                       = "nlb-${var.name_prefix}"
  internal                   = true
  load_balancer_type         = "network"
  subnets                    = [aws_subnet.nlb.id]
  enable_deletion_protection = false
  tags                       = { Name = "nlb-svc" }
}

# FAULT 1 (with sg-svc): client IP preservation delivers client addresses, which sg-svc does not admit.
resource "aws_lb_target_group" "svc" {
  name               = "tg-${var.name_prefix}"
  port               = 80
  protocol           = "TCP"
  vpc_id             = aws_vpc.service.id
  preserve_client_ip = "true"
  tags               = { Name = "tg-svc" }
}

resource "aws_lb_target_group_attachment" "svc" {
  target_group_arn = aws_lb_target_group.svc.arn
  target_id        = aws_instance.svc.id
  port             = 80
}

resource "aws_lb_listener" "svc" {
  load_balancer_arn = aws_lb.svc.arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc.arn
  }
  tags = { Name = "listener-svc" }
}
```

**`labs/ans-28-flow-logs-fix/terraform/acl.tf`**
```hcl
# acl.tf
#
# Plain English: snet-svc's own network ACL, acl-svc. Everything may come in;
# going out, rule 90 denies everything to the client VPC (vpc-lab) before
# rule 100 allows everything else. THIS IS FAULT 2 (readme, What was
# broken): network ACLs are stateless, so vm-svc's replies to the client are
# dropped on the way out, while the health checks' replies (to snet-nlb)
# pass. Tear-down note (ruling A82): destroying the association hands
# snet-svc back to the VPC's default ACL, which the lab role may do.

resource "aws_network_acl" "svc" {
  vpc_id = aws_vpc.service.id
  tags   = { Name = "acl-svc" }
}

resource "aws_network_acl_association" "svc" {
  network_acl_id = aws_network_acl.svc.id
  subnet_id      = aws_subnet.svc.id
}

resource "aws_network_acl_rule" "in_all" {
  network_acl_id = aws_network_acl.svc.id
  rule_number    = 100
  egress         = false
  protocol       = "-1"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
}

# FAULT 2: replies to the client VPC are denied before rule 100 allows everything out.
resource "aws_network_acl_rule" "out_deny_client" {
  network_acl_id = aws_network_acl.svc.id
  rule_number    = 90
  egress         = true
  protocol       = "-1"
  rule_action    = "deny"
  cidr_block     = local.vpc_cidr
}

resource "aws_network_acl_rule" "out_all" {
  network_acl_id = aws_network_acl.svc.id
  rule_number    = 100
  egress         = true
  protocol       = "-1"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
}
```

**`labs/ans-28-flow-logs-fix/terraform/flowlogs.tf`**
```hcl
# flowlogs.tf
#
# Plain English: VPC Flow Logs for lab 28's service VPC, every accepted and
# rejected flow, twice. flow-service writes one-minute records to the log
# group /cloudlabs/<id>/flow (one day; A56) as the lab's role
# lab-<id>-flowlogs, allowed only that group. flow-service-s3 writes the same
# records to the lab's own bucket cloudlabs-<name_prefix>-flowlogs, as
# plain text in Hive-style folders by the hour (aws-account-id=,
# aws-service=, aws-region=, year=, month=, day=, hour=), which athena.tf's
# table reads. The bucket blocks public access, empties itself at
# tear-down, and lets only AWS's log delivery service write, for this
# account only (rulings P7, P8).

locals {
  account          = data.aws_caller_identity.current.account_id
  flowlogs_bucket  = "cloudlabs-${var.name_prefix}-flowlogs"
  flowlogs_arn     = "arn:aws:s3:::cloudlabs-${var.name_prefix}-flowlogs"
  flow_group       = "/cloudlabs/${var.lab_id}/flow"
  flow_group_arn   = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/cloudlabs/${var.lab_id}/flow"
  flowlogs_s3_root = "AWSLogs/aws-account-id=${data.aws_caller_identity.current.account_id}"
}

resource "aws_cloudwatch_log_group" "flow" {
  name              = local.flow_group
  retention_in_days = 1
}

resource "aws_iam_role" "flowlogs" {
  name                 = "lab-${var.lab_id}-flowlogs"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account } }
    }]
  })
}

resource "aws_iam_policy" "flowlogs" {
  name = "lab-${var.lab_id}-flowlogs"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabFlowLogGroup", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"], Resource = "${local.flow_group_arn}:*" },
      { Sid = "FindGroups", Effect = "Allow", Action = "logs:DescribeLogGroups", Resource = "*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "flowlogs" {
  role       = aws_iam_role.flowlogs.name
  policy_arn = aws_iam_policy.flowlogs.arn
}

resource "aws_flow_log" "service" {
  vpc_id                   = aws_vpc.service.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow.arn
  iam_role_arn             = aws_iam_role.flowlogs.arn
  max_aggregation_interval = 60
  tags                     = { Name = "flow-service" }
  depends_on               = [aws_iam_role_policy_attachment.flowlogs]
}

resource "aws_s3_bucket" "flowlogs" {
  bucket        = local.flowlogs_bucket
  force_destroy = true
  tags          = { Name = "flowlogs" }
}

resource "aws_s3_bucket_public_access_block" "flowlogs" {
  bucket                  = aws_s3_bucket.flowlogs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "flowlogs" {
  bucket = aws_s3_bucket.flowlogs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "LogDeliveryWrite"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${local.flowlogs_arn}/${local.flowlogs_s3_root}/*"
        Condition = { StringEquals = { "aws:SourceAccount" = local.account } }
      },
      {
        Sid       = "LogDeliveryAclCheck"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = local.flowlogs_arn
        Condition = { StringEquals = { "aws:SourceAccount" = local.account } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.flowlogs]
}

resource "aws_flow_log" "service_s3" {
  vpc_id                   = aws_vpc.service.id
  traffic_type             = "ALL"
  log_destination_type     = "s3"
  log_destination          = aws_s3_bucket.flowlogs.arn
  max_aggregation_interval = 60
  destination_options {
    file_format                = "plain-text"
    hive_compatible_partitions = true
    per_hour_partition         = true
  }
  tags       = { Name = "flow-service-s3" }
  depends_on = [aws_s3_bucket_policy.flowlogs]
}
```

**`labs/ans-28-flow-logs-fix/terraform/athena.tf`**
```hcl
# athena.tf
#
# Plain English: lab 28's way to query the S3 flow logs with SQL. The Glue
# database lab_<id> (Glue takes no hyphens; A97) holds one table,
# vpc_flow_logs, over the bucket's AWSLogs/ folder: the default (version 2)
# flow-log fields, read as space-separated text, partitioned like the
# folders the flow log writes. Partition projection works the partitions out
# from the query itself, so nothing has to load them. The Athena workgroup
# lab-<id>-wg keeps its results in the same bucket under athena/, refuses any
# query that would scan more than 10 MB, and is deleted with its queries.

locals {
  glue_db = "lab_${replace(var.lab_id, "-", "_")}"
}

resource "aws_glue_catalog_database" "flow" {
  name        = local.glue_db
  description = "lab ${var.lab_id}: the flow logs' table"
  tags        = { Name = "glue-flowlogs" }
}

resource "aws_glue_catalog_table" "flow" {
  name          = "vpc_flow_logs"
  database_name = aws_glue_catalog_database.flow.name
  table_type    = "EXTERNAL_TABLE"
  description   = "lab ${var.lab_id}: vpc-service flow logs in S3, partitioned by the hour"
  parameters = {
    "EXTERNAL"                         = "TRUE"
    "skip.header.line.count"           = "1"
    "projection.enabled"               = "true"
    "projection.aws-account-id.type"   = "enum"
    "projection.aws-account-id.values" = local.account
    "projection.aws-service.type"      = "enum"
    "projection.aws-service.values"    = "vpcflowlogs"
    "projection.aws-region.type"       = "enum"
    "projection.aws-region.values"     = var.region
    "projection.year.type"             = "integer"
    "projection.year.range"            = "2026,2036"
    "projection.month.type"            = "integer"
    "projection.month.range"           = "1,12"
    "projection.month.digits"          = "2"
    "projection.day.type"              = "integer"
    "projection.day.range"             = "1,31"
    "projection.day.digits"            = "2"
    "projection.hour.type"             = "integer"
    "projection.hour.range"            = "0,23"
    "projection.hour.digits"           = "2"
  }

  partition_keys {
    name = "aws-account-id"
    type = "string"
  }
  partition_keys {
    name = "aws-service"
    type = "string"
  }
  partition_keys {
    name = "aws-region"
    type = "string"
  }
  partition_keys {
    name = "year"
    type = "string"
  }
  partition_keys {
    name = "month"
    type = "string"
  }
  partition_keys {
    name = "day"
    type = "string"
  }
  partition_keys {
    name = "hour"
    type = "string"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.flowlogs.bucket}/AWSLogs/"
    input_format  = "org.apache.hadoop.mapred.TextInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"
    ser_de_info {
      serialization_library = "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe"
      parameters = {
        "field.delim"          = " "
        "serialization.format" = " "
      }
    }
    columns {
      name = "version"
      type = "int"
    }
    columns {
      name = "account_id"
      type = "string"
    }
    columns {
      name = "interface_id"
      type = "string"
    }
    columns {
      name = "srcaddr"
      type = "string"
    }
    columns {
      name = "dstaddr"
      type = "string"
    }
    columns {
      name = "srcport"
      type = "int"
    }
    columns {
      name = "dstport"
      type = "int"
    }
    columns {
      name = "protocol"
      type = "bigint"
    }
    columns {
      name = "packets"
      type = "bigint"
    }
    columns {
      name = "bytes"
      type = "bigint"
    }
    columns {
      name = "start"
      type = "bigint"
    }
    columns {
      name = "end"
      type = "bigint"
    }
    columns {
      name = "action"
      type = "string"
    }
    columns {
      name = "log_status"
      type = "string"
    }
  }
}

resource "aws_athena_workgroup" "flow" {
  name          = "lab-${var.lab_id}-wg"
  force_destroy = true
  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = false
    bytes_scanned_cutoff_per_query     = 10485760
    result_configuration {
      output_location = "s3://${aws_s3_bucket.flowlogs.bucket}/athena/"
    }
  }
  tags = { Name = "athena-wg" }
}
```

**`labs/ans-28-flow-logs-fix/terraform/mirror.tf`**
```hcl
# mirror.tf
#
# Plain English: lab 28's traffic mirroring pieces, ready for a session you
# make by hand (a Thing to try; a session is billed by the hour, so the lab
# never leaves one running). The target is vm-monitor's own network
# interface (ruling P17); the filter, mirror-filter-web, keeps only TCP port
# 80 inside the lab's slot, in both directions: requests arriving at port 80
# and replies leaving it. Mirrored packets reach vm-monitor wrapped in VXLAN
# (UDP 4789).

resource "aws_ec2_traffic_mirror_target" "monitor" {
  description          = "lab ${var.lab_id}: vm-monitor receives mirrored traffic"
  network_interface_id = aws_instance.monitor.primary_network_interface_id
  tags                 = { Name = "mirror-monitor" }
}

resource "aws_ec2_traffic_mirror_filter" "web" {
  description = "lab ${var.lab_id}: TCP port 80 inside the slot"
  tags        = { Name = "mirror-filter-web" }
}

resource "aws_ec2_traffic_mirror_filter_rule" "in" {
  traffic_mirror_filter_id = aws_ec2_traffic_mirror_filter.web.id
  description              = "requests to port 80"
  rule_number              = 100
  rule_action              = "accept"
  traffic_direction        = "ingress"
  protocol                 = 6
  source_cidr_block        = var.address_space
  destination_cidr_block   = var.address_space
  destination_port_range {
    from_port = 80
    to_port   = 80
  }
}

resource "aws_ec2_traffic_mirror_filter_rule" "out" {
  traffic_mirror_filter_id = aws_ec2_traffic_mirror_filter.web.id
  description              = "replies from port 80"
  rule_number              = 100
  rule_action              = "accept"
  traffic_direction        = "egress"
  protocol                 = 6
  source_cidr_block        = var.address_space
  destination_cidr_block   = var.address_space
  source_port_range {
    from_port = 80
    to_port   = 80
  }
}
```

**`labs/ans-28-flow-logs-fix/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 28's three instances, all t4g.nano. vm-client in the
# client VPC (snet-private-1; also in the template's sg-vms, so the VPN
# server can reach it when peered) is where the requests start. vm-svc in
# snet-svc serves a page on port 80 behind the load balancer; its security
# group, sg-svc, admits port 80 only from snet-nlb's range, which is the
# other half of fault 1 (readme, What was broken). vm-monitor in snet-nlb is
# the mirror target: it admits VXLAN (UDP 4789) from the service VPC.

locals {
  svc_unit = join("\n", [
    "[Unit]",
    "Description=Lab 28 service page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  svc_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/srv/www/index.html", permissions = "0644", content = "vm-svc behind nlb-svc: it works\n" },
      { path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.svc_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_security_group" "client" {
  name        = "lab-client"
  description = "vm-client: ping from the service VPC"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-client" }
}

resource "aws_vpc_security_group_ingress_rule" "client_ping" {
  security_group_id = aws_security_group.client.id
  cidr_ipv4         = local.svc_vpc_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_security_group" "svc" {
  name        = "lab-svc"
  description = "vm-svc: HTTP from the NLB subnet, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.service.id
  tags        = { Name = "sg-svc" }
}

# FAULT 1 (with the target group): HTTP only from snet-nlb, but client IP preservation delivers vpc-lab addresses.
resource "aws_vpc_security_group_ingress_rule" "svc_http" {
  security_group_id = aws_security_group.svc.id
  cidr_ipv4         = local.nlb_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "svc_ssh" {
  security_group_id            = aws_security_group.svc.id
  referenced_security_group_id = aws_security_group.service_eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "svc_all" {
  security_group_id = aws_security_group.svc.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "monitor" {
  name        = "lab-monitor"
  description = "vm-monitor: VXLAN mirror traffic from the service VPC, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.service.id
  tags        = { Name = "sg-monitor" }
}

resource "aws_vpc_security_group_ingress_rule" "monitor_vxlan" {
  security_group_id = aws_security_group.monitor.id
  cidr_ipv4         = local.svc_vpc_cidr
  ip_protocol       = "udp"
  from_port         = 4789
  to_port           = 4789
}

resource "aws_vpc_security_group_ingress_rule" "monitor_ssh" {
  security_group_id            = aws_security_group.monitor.id
  referenced_security_group_id = aws_security_group.service_eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "monitor_all" {
  security_group_id = aws_security_group.monitor.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "client" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id, aws_security_group.client.id]
  user_data              = local.cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-client" })
  tags        = { Name = "vm-client" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "svc" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.svc.id
  vpc_security_group_ids = [aws_security_group.svc.id]
  user_data              = local.svc_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-svc" })
  tags        = { Name = "vm-svc" }
  depends_on  = [aws_vpc_endpoint.service_s3, aws_route_table_association.svc, aws_network_acl_association.svc]
}

resource "aws_instance" "monitor" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.nlb.id
  vpc_security_group_ids = [aws_security_group.monitor.id]
  user_data              = local.cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-monitor" })
  tags        = { Name = "vm-monitor" }
  depends_on  = [aws_vpc_endpoint.service_s3, aws_route_table_association.nlb]
}
```

**`labs/ans-28-flow-logs-fix/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 28 is up (AWS labs spec
# §4, §10): the three instances' addresses, console SSH to each, the request
# that fails, the command that starts a mirror session from vm-svc to
# vm-monitor (tagged for the lab, so tear-down removes it), the flow log
# group to tail, and, while peered, vm-client (the client VPC is the hub).

output "private_ips" {
  value = { "vm-client" = aws_instance.client.private_ip, "vm-svc" = aws_instance.svc.private_ip, "vm-monitor" = aws_instance.monitor.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.client.id} --os-user labadmin --connection-type eice",
    "From vm-client: curl --max-time 5 http://${aws_lb.svc.dns_name}",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.svc.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.monitor.id} --os-user labadmin --connection-type eice",
    "aws ec2 create-traffic-mirror-session --network-interface-id ${aws_instance.svc.primary_network_interface_id} --traffic-mirror-target-id ${aws_ec2_traffic_mirror_target.monitor.id} --traffic-mirror-filter-id ${aws_ec2_traffic_mirror_filter.web.id} --session-number 1 --tag-specifications 'ResourceType=traffic-mirror-session,Tags=[{Key=cloudlabs-lab,Value=${var.lab_id}}]'",
    "aws logs tail ${aws_cloudwatch_log_group.flow.name} --since 10m",
    "ssh labadmin@${aws_instance.client.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/ans-28-flow-logs-fix/readme.md`** (exactly):
````markdown
A client VPC peered to a service VPC, where an internal Network Load Balancer fronts a small web service. The load balancer says its target is healthy, yet the client never gets an answer. VPC Flow Logs record the service VPC twice, to CloudWatch Logs and to S3 with an Athena table over them, and a traffic mirror target and filter are ready for you to copy the packets themselves. Use them, and the VPC analyzers, to find the two faults and fix them. Everything is listed in the lab's resource group, `lab-ans-28-flow-logs-fix`, in AWS Resource Groups (London).
From the ANS-C01 outline: troubleshoot network connectivity with VPC Flow Logs, traffic mirroring, Reachability Analyzer and Network Access Analyzer, and analyse flow logs at scale with Athena.

## What it deploys

- `vpc-lab`, the client VPC (the slot's first /20), with `vm-client` (t4g.nano) in `snet-private-1`, and `vpc-service` (the second /20), joined by the peering `pcx-client-service`
- In `vpc-service`: the internal NLB `nlb-<name prefix>` (Name `nlb-svc`) and the monitor `vm-monitor` in `snet-nlb`; the web service `vm-svc` (a page on port 80, security group `sg-svc`), the Instance Connect Endpoint `eice-service` and the network ACL `acl-svc` in `snet-svc`
- Flow logs of `vpc-service`: `flow-service` to the log group `/cloudlabs/ans-28-flow-logs-fix/flow` (kept one day) through the role `lab-ans-28-flow-logs-fix-flowlogs`, and `flow-service-s3` to the bucket `cloudlabs-<name prefix>-flowlogs` in hourly Hive-style folders
- The Glue database `lab_ans_28_flow_logs_fix` with the table `vpc_flow_logs` over that bucket, and the Athena workgroup `lab-ans-28-flow-logs-fix-wg` (results in the same bucket; no query may scan more than 10 MB)
- The traffic mirror target `mirror-monitor` (`vm-monitor`'s interface) and the filter `mirror-filter-web` (TCP port 80 both ways, inside the slot); no mirror session until you make one

Sign in as `labadmin`; the password is behind **Show**. With **Peer to gateway** (only while the VPN server runs in AWS) `vm-client` is reachable from a tunnel client; the service VPC is not, as a peering never carries traffic onward.

```text
lab-ans-28-flow-logs-fix (London)
  vpc-lab (client)                        vpc-service
    vm-client --TCP 80--> pcx-client-service --> snet-nlb: nlb-svc (client IP preservation) --> snet-svc [acl-svc]: vm-svc [sg-svc]
    rt-private: vpc-service -> pcx         rt-service: vpc-lab -> pcx
                                           snet-nlb: vm-monitor <--VXLAN 4789-- mirror session (by hand)
  flow-service --> /cloudlabs/<id>/flow    flow-service-s3 --> cloudlabs-<prefix>-flowlogs --> Athena vpc_flow_logs
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you (vm-client)
```

## Symptom

From `vm-client`, `curl http://<the NLB's name>` (the second Connect line) hangs or fails; the target group shows the target healthy. `vm-svc` is up and serving: on `vm-svc` itself, `curl localhost` answers "it works". Find what stops the client's requests, fix it, and show that the command on `vm-client` now gets the page.

<details>
<summary>What was broken</summary>

Two faults, and the request only works once both are fixed:

- **The service's security group admits only the load balancer's subnet, but the load balancer keeps the client's address.** `sg-svc` allows TCP 80 from `snet-nlb`'s range only. The target group has client IP preservation on, so the requests reach `vm-svc` from `vm-client`'s own address in `vpc-lab`, which `sg-svc` drops. The health checks come from the NLB's own addresses in `snet-nlb`, so the target looks healthy. The flow log for `vm-svc`'s interface shows the client's packets to port 80 as `REJECT`. Fix: allow TCP 80 from `vpc-lab`'s range in `sg-svc` (or turn client IP preservation off on the target group, and then `vm-svc` never sees who called).
- **The service subnet's network ACL drops the replies to the client range.** `acl-svc` has outbound rule 90 denying everything to `vpc-lab`'s range, before rule 100 allows everything out. Network ACLs are stateless, so with the first fault fixed the flow logs show the client's request to port 80 as an `ACCEPT` inbound record and `vm-svc`'s reply as a `REJECT` outbound record. Fix: delete rule 90 (or change it to allow).

</details>

## Things to try

- Read the CloudWatch copy first: in CloudWatch Logs Insights, on `/cloudlabs/ans-28-flow-logs-fix/flow`, run `fields @timestamp, @message | filter @message like / 80 / | sort @timestamp desc | limit 50`, then curl again and compare. Logs Insights charges for the data scanned (about half a penny per GB).
- Query the S3 copy with SQL: in Athena, choose the workgroup `lab-ans-28-flow-logs-fix-wg` and the database `lab_ans_28_flow_logs_fix`, then run `SELECT srcaddr, dstaddr, srcport, dstport, action, count(*) AS flows FROM vpc_flow_logs WHERE year = '2026' AND month = '10' AND day = '16' AND (dstport = 80 OR srcport = 80) GROUP BY 1, 2, 3, 4, 5 ORDER BY flows DESC` with today's date in place of the one shown. S3 files arrive every few minutes. Athena charges per data scanned (about 0.4p per 100 MB; this workgroup stops any query at 10 MB).
- Run the analyzers: Reachability Analyzer (VPC console, Network Manager) from `vm-client` to the NLB on TCP 80 and from `vm-svc` back to `vm-client`, before and after each fix; each analysis costs about 7.5p. Network Access Analyzer can show every path into `vpc-service` on port 80; it is charged per network interface analysed (fractions of a penny here).
- Mirror the packets: run the mirror-session Connect line (`aws ec2 create-traffic-mirror-session ...`, with the lab's tag) in CloudShell, then on `vm-monitor` run `sudo dnf install -y tcpdump && sudo tcpdump -n -i any udp port 4789` and curl from `vm-client`: you see each request wrapped in VXLAN, with the client's address inside, before any security group decides. A session costs about 1.1p per hour while it exists (delete it with `aws ec2 delete-traffic-mirror-session --traffic-mirror-session-id <id>`, or leave it to tear-down, which removes it by its lab tag). Mirroring works only from instance types AWS lists as supported (the Learn more link); if AWS refuses `vm-svc` as a source, read that list and note which families qualify.
- With everything fixed, turn client IP preservation off on the target group (EC2 console, Target groups, Attributes): the request still works, and `vm-svc`'s flow log now shows it arriving from the NLB's address. Which design would you choose, and what would you log instead?

## Learn more

- [Publish flow logs to Amazon S3](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs-s3.html)
- [Query Amazon VPC flow logs with Athena](https://docs.aws.amazon.com/athena/latest/ug/vpc-flow-logs.html)
- [What is Traffic Mirroring?](https://docs.aws.amazon.com/vpc/latest/mirroring/what-is-traffic-mirroring.html)
- [Edit target group attributes for your Network Load Balancer (client IP preservation)](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/edit-target-group-attributes.html)
- [What is Reachability Analyzer?](https://docs.aws.amazon.com/vpc/latest/reachability/what-is-reachability-analyzer.html)
- [What is Network Access Analyzer?](https://docs.aws.amazon.com/vpc/latest/network-access-analyzer/what-is-network-access-analyzer.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-28-flow-logs-fix` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-28-flow-logs-fix.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Find why a load-balanced service never answers its client, using flow logs, Athena, mirroring and the VPC analyzers.
learn:
  - See how NLB client IP preservation changes what a target's security group must admit
  - Tell a stateless network ACL refusal from a security group one in flow logs and Athena
  - Mirror a service's traffic to a monitor instance and read it with tcpdump
learning_min: 75
```

**The diagram** must contain: `resourceGroup lab-ans-28-flow-logs-fix · London`; `vnet vpc-lab` with `subnet snet-private-1`, `snet-private-2`; `vnet vpc-service` with `subnet snet-nlb`, `snet-svc`; a `peering` edge between `vpc-service` and `vpc-lab`; `loadBalancer nlb-svc` with a `traffic` edge `TCP 80` to `vm vm-svc`; `vm vm-client`, `vm vm-monitor`; `generic acl-svc`; `flowLog flow-service`, `flow-service-s3`; `logAnalytics /cloudlabs/ans-28-flow-logs-fix/flow`; `managedIdentity lab-ans-28-flow-logs-fix-flowlogs`; `storage flowlogs`; `generic glue-flowlogs`, `athena-wg`; `generic mirror-monitor` with a `dependency` edge `mirror to` to `vm-monitor`; `generic mirror-filter-web`; `routeTable rt-private`, `rt-service`; `nsg sg-client`, `sg-svc`, `sg-monitor`, `sg-vms`, `sg-eice`, `sg-eice-service`; `bastion eice-lab`, `eice-service < snet-svc`; `privateEndpoint vpce-s3`, `vpce-s3-service`. No node for the table, the filter rules or the ACL rules (folded).

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-ans-28.test.mjs`:

```js
// labs-aws-ans-28.test.mjs
//
// Plain English: lab ans-28-flow-logs-fix is the break-fix lab AWS labs spec
// §12.2 row 28 describes, with exactly its two faults (ruling A28): the
// targets' security group admits only the NLB subnets while client IP
// preservation delivers client addresses, and the service subnet's ACL drops
// the replies to the client range. Flow logs go to CloudWatch and to S3 with
// an Athena table; a mirror target and filter wait for a session made by
// hand (rulings P8, P17).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-28-flow-logs-fix";
const block = (lab, type, name) => resources(lab, type).find((r) => r.labels[1] === name)?.body ?? "";

test("ans-28 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-28's lab.yaml: §12.2 row 28, a break-fix after soa-08, two /20s, a role, about 4p/h", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "break-fix", ["ans.operations", "ans.security", "soa.networking"], ["soa-08-vpc-fix"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 6, destroy_min: 5, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano", "t4g.nano"] });
  assert.deepEqual(yaml.identity, { creates: ["role"], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.03 && total < 0.05, `about £0.04/h, got ${total}`);
  assert.equal(yaml.cost.items.find((i) => i.name === "Network Load Balancer, hourly").whole_hours, true);
});

test("fault 1: sg-svc admits TCP 80 only from snet-nlb, while the target group keeps client IP preservation on", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(block(lab, "aws_lb_target_group", "svc"), /preserve_client_ip = "true"/);
  assert.match(block(lab, "aws_lb", "svc"), /internal\s+= true/);
  assert.doesNotMatch(block(lab, "aws_lb", "svc"), /security_groups/);
  const http = resources(lab, "aws_vpc_security_group_ingress_rule").filter((r) => /security_group_id\s+= aws_security_group\.svc\.id/.test(r.body) && /from_port\s+= 80/.test(r.body));
  assert.deepEqual(http.map((r) => r.labels[1]), ["svc_http"]);
  assert.match(http[0].body, /cidr_ipv4\s+= local\.nlb_cidr/);
  assert.match(tf, /nlb_cidr\s+= cidrsubnet\(local\.svc_vpc_cidr, 4, 0\)/);
  assert.equal([...tf.matchAll(/# FAULT 1/g)].length, 2);
});

test("fault 2: acl-svc on snet-svc denies everything out to vpc-lab at rule 90, before rule 100 allows everything", () => {
  const { lab, tf } = awsLab(ID);
  const rules = resources(lab, "aws_network_acl_rule").map((r) => r.body);
  const deny = rules.filter((b) => /rule_action\s+= "deny"/.test(b));
  assert.equal(deny.length, 1);
  for (const re of [/rule_number\s+= 90/, /egress\s+= true/, /cidr_block\s+= local\.vpc_cidr/, /protocol\s+= "-1"/]) assert.match(deny[0], re);
  assert.ok(rules.some((b) => /egress\s+= true/.test(b) && /rule_number\s+= 100/.test(b) && /rule_action\s+= "allow"/.test(b)));
  assert.ok(rules.some((b) => /egress\s+= false/.test(b) && /rule_action\s+= "allow"/.test(b)));
  assert.match(block(lab, "aws_network_acl_association", "svc"), /subnet_id\s+= aws_subnet\.svc\.id/);
  assert.match(tf, /# FAULT 2/);
});

test("ruling A75: the service VPC's Instance Connect Endpoint sits in snet-svc beside vm-svc; the client VPC is the hub", () => {
  const { lab, files } = awsLab(ID);
  assert.match(block(lab, "aws_ec2_instance_connect_endpoint", "service"), /subnet_id\s+= aws_subnet\.svc\.id/);
  assert.match(block(lab, "aws_instance", "svc"), /subnet_id\s+= aws_subnet\.svc\.id/);
  assert.match(files["outputs.tf"], /output "peer_route_table_ids" \{\n  value = \[aws_route_table\.private\.id\]/);
});

test("ruling P8: flow logs to the lab's group through the lab's role and to the lab's bucket in hourly Hive folders, the bucket's policy naming this account", () => {
  const { lab } = awsLab(ID);
  assert.deepEqual(resources(lab, "aws_flow_log").map((r) => r.labels[1]).sort(), ["service", "service_s3"]);
  const cw = block(lab, "aws_flow_log", "service");
  for (const re of [/log_destination\s+= aws_cloudwatch_log_group\.flow\.arn/, /iam_role_arn\s+= aws_iam_role\.flowlogs\.arn/, /vpc_id\s+= aws_vpc\.service\.id/]) assert.match(cw, re);
  const s3 = block(lab, "aws_flow_log", "service_s3");
  for (const re of [/log_destination_type\s+= "s3"/, /log_destination\s+= aws_s3_bucket\.flowlogs\.arn/, /file_format\s+= "plain-text"/, /hive_compatible_partitions = true/, /per_hour_partition\s+= true/, /depends_on = \[aws_s3_bucket_policy\.flowlogs\]/]) assert.match(s3, re);
  const pol = block(lab, "aws_s3_bucket_policy", "flowlogs");
  assert.equal([...pol.matchAll(/"aws:SourceAccount" = local\.account/g)].length, 2);
  assert.match(pol, /Resource\s+= "\$\{local\.flowlogs_arn\}\/\$\{local\.flowlogs_s3_root\}\/\*"/);
  assert.match(block(lab, "aws_iam_role", "flowlogs"), /"aws:SourceAccount" = local\.account/);
  assert.match(block(lab, "aws_cloudwatch_log_group", "flow"), /retention_in_days = 1/);
});

test("ruling A97: the Athena table in lab_<id> over the bucket's AWSLogs/, seven projected partitions, a workgroup capped at 10 MB", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(tf, /glue_db = "lab_\$\{replace\(var\.lab_id, "-", "_"\)\}"/);
  const t = block(lab, "aws_glue_catalog_table", "flow");
  for (const re of [/database_name = aws_glue_catalog_database\.flow\.name/, /location\s+= "s3:\/\/\$\{aws_s3_bucket\.flowlogs\.bucket\}\/AWSLogs\/"/, /"projection\.enabled"\s+= "true"/, /"skip\.header\.line\.count"\s+= "1"/]) assert.match(t, re);
  assert.deepEqual([...t.matchAll(/partition_keys \{\n\s+name = "([^"]+)"/g)].map((m) => m[1]), ["aws-account-id", "aws-service", "aws-region", "year", "month", "day", "hour"]);
  assert.equal([...t.matchAll(/columns \{/g)].length, 14);
  const wg = block(lab, "aws_athena_workgroup", "flow");
  for (const re of [/force_destroy = true/, /bytes_scanned_cutoff_per_query\s+= 10485760/, /enforce_workgroup_configuration\s+= true/, /output_location = "s3:\/\/\$\{aws_s3_bucket\.flowlogs\.bucket\}\/athena\/"/]) assert.match(wg, re);
});

test("ruling P17: the mirror target is vm-monitor's own interface, the filter keeps TCP 80 inside the slot both ways, and no session is built", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(block(lab, "aws_ec2_traffic_mirror_target", "monitor"), /network_interface_id = aws_instance\.monitor\.primary_network_interface_id/);
  const rules = resources(lab, "aws_ec2_traffic_mirror_filter_rule");
  assert.deepEqual(rules.map((r) => r.labels[1]).sort(), ["in", "out"]);
  for (const r of rules) for (const re of [/protocol\s+= 6/, /source_cidr_block\s+= var\.address_space/, /destination_cidr_block\s+= var\.address_space/, /from_port = 80/, /rule_action\s+= "accept"/]) assert.match(r.body, re, r.labels[1]);
  assert.doesNotMatch(tf, /resource "aws_ec2_traffic_mirror_session"/);
  assert.match(block(lab, "aws_vpc_security_group_ingress_rule", "monitor_vxlan"), /from_port\s+= 4789/);
});

test("ans-28's readme: Symptom, a closed What was broken naming both faults, the per-use charges, and valid learning content", () => {
  const { readme, learning, yaml } = awsLab(ID);
  assert.match(readme, /## Symptom/);
  assert.match(readme, /<details>\n<summary>What was broken<\/summary>/);
  for (const s of ["sg-svc", "acl-svc", "client IP preservation", "rule 90", "REJECT", "vpc_flow_logs", "lab-ans-28-flow-logs-fix-wg", "7.5p", "per network interface", "Athena charges", "create-traffic-mirror-session"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-ans-28.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged from `labs/_template-aws/`; trim `variables.tf` to the seven variables named; `terraform fmt -check` clean where terraform is installed.

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/ans-28-flow-logs-fix.mjs` (header comment in the house form, as soa-08's): `c = ctxAws("ans-28-flow-logs-fix", "28")`; `variables: c.variables`; `providers: ["aws"]`; `providerConfig: AWS_PROVIDER_CONFIG`; `data: awsData()`; with `svcVpc = cidrsubnet(c.address, 2, 1)`, `nlbCidr = cidrsubnet(svcVpc, 4, 0)`, `svcCidr = cidrsubnet(svcVpc, 4, 1)`, `bucket = "cloudlabs-a28k3x9q-flowlogs"`, `group = "/cloudlabs/ans-28-flow-logs-fix/flow"`, resources in file order:
  - `...templateResources(c)`.
  - **service.tf**: `aws_vpc.service` (known `svcVpc`, ref `local.svc_vpc_cidr`, Name `vpc-service`); `aws_subnet.nlb`, `.svc` (known `nlbCidr`/`svcCidr`, `eu-west-2a`; unknown `vpc_id`); `aws_route_table.service`; the two associations; `aws_vpc_endpoint.service_s3`; `aws_vpc_peering_connection.client_service` (known `auto_accept: true`, Name; unknown `vpc_id` → `aws_vpc.lab.id`, `peer_vpc_id` → `aws_vpc.service.id`); `aws_route.client_to_service` (known `svcVpc`; unknown `route_table_id` → `aws_route_table.private.id`, `vpc_peering_connection_id`), `aws_route.service_to_client` (known `c.vpcCidr`, ref `local.vpc_cidr`); `aws_security_group.service_eice` and its egress (known `svcVpc`); `aws_ec2_instance_connect_endpoint.service` (unknown `subnet_id` → `aws_subnet.svc.id`, `security_group_ids.0`).
  - **nlb.tf**: `aws_lb.svc` (known `name: "nlb-a28k3x9q"`, `internal: true`, `load_balancer_type: "network"`, Name `nlb-svc`; unknown `subnets` → `aws_subnet.nlb.id`); `aws_lb_target_group.svc` (known `tg-a28k3x9q`, 80, TCP, `preserve_client_ip: "true"`; unknown `vpc_id`); the attachment (→ `aws_instance.svc.id`); the listener.
  - **acl.tf**: soa-08's NACL entries, rewritten: `aws_network_acl.svc` (unknown `vpc_id` → `aws_vpc.service.id`, Name `acl-svc`); `aws_network_acl_association.svc` (unknown ids → `aws_network_acl.svc.id`, `aws_subnet.svc.id`); three `aws_network_acl_rule` (`in_all` `{ rule_number: 100, egress: false, protocol: "-1", rule_action: "allow", cidr_block: "0.0.0.0/0" }`, `out_deny_client` `{ 90, true, "-1", "deny", c.vpcCidr }` with ref `local.vpc_cidr`, `out_all` `{ 100, true, "-1", "allow", "0.0.0.0/0" }`; each unknown `network_acl_id`).
  - **flowlogs.tf**: `aws_cloudwatch_log_group.flow` (known `name: group`, `retention_in_days: 1`; ref `local.flow_group`); `aws_iam_role.flowlogs` and `aws_iam_policy.flowlogs` exactly as soa-08's fixture writes them, with this lab's id (both documents known at plan; refs `local.account`, `local.flow_group_arn`); the attachment; `aws_flow_log.service` (as soa-08's `flowLog` helper builds it, `vpc_id` → `aws_vpc.service`, Name `flow-service`); `aws_s3_bucket.flowlogs` (known `bucket`, `force_destroy: true`, Name `flowlogs`); its public access block; `aws_s3_bucket_policy.flowlogs` (unknown `bucket`; `policy` known: the two statements with `arn:aws:s3:::cloudlabs-a28k3x9q-flowlogs/AWSLogs/aws-account-id=123456789012/*` and the bucket ARN, each `Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } }`); `aws_flow_log.service_s3` (known `traffic_type: "ALL"`, `log_destination_type: "s3"`, `max_aggregation_interval: 60`, `destination_options: [{ file_format: "plain-text", hive_compatible_partitions: true, per_hour_partition: true }]`, Name `flow-service-s3`; unknown `vpc_id`, `log_destination` → `aws_s3_bucket.flowlogs.arn`).
  - **athena.tf**: `aws_glue_catalog_database.flow` (known `name: "lab_ans_28_flow_logs_fix"`, ref `local.glue_db`); `aws_glue_catalog_table.flow` (known `name`, `table_type`, `description`, every `parameters` entry (the account `123456789012` and region `eu-west-2` with refs `local.account`, `var.region`), the seven `partition_keys`, `storage_descriptor` with `location: "s3://cloudlabs-a28k3x9q-flowlogs/AWSLogs/"` (ref `aws_s3_bucket.flowlogs.bucket`; known at plan because the bucket's name is), formats, SerDe and the 14 `columns`; unknown `database_name` → `aws_glue_catalog_database.flow.name`); `aws_athena_workgroup.flow` (known name, `force_destroy: true`, the `configuration` with `output_location: "s3://cloudlabs-a28k3x9q-flowlogs/athena/"`).
  - **mirror.tf**: `aws_ec2_traffic_mirror_target.monitor` (known description, Name `mirror-monitor`; unknown `network_interface_id` → `aws_instance.monitor.primary_network_interface_id`); `aws_ec2_traffic_mirror_filter.web` (known description, Name); `aws_ec2_traffic_mirror_filter_rule.in`, `.out` (known `rule_number: 100`, `rule_action: "accept"`, `traffic_direction` `ingress`/`egress`, `protocol: 6`, `source_cidr_block` and `destination_cidr_block` `c.address` (ref `var.address_space`), the port range block; unknown `traffic_mirror_filter_id`).
  - **compute.tf**: `aws_security_group.client`, `.svc`, `.monitor` and their seven rules (`svc_http`'s `cidr_ipv4: nlbCidr` with ref `local.nlb_cidr`; the `_ssh` rules' `referenced_security_group_id` → `aws_security_group.service_eice.id`); `al2023Instance(c, { key: "client", name: "vm-client", type: "t4g.nano", sgs: ["aws_security_group.vms", "aws_security_group.client"] })`; `al2023Instance(c, { key: "svc", name: "vm-svc", type: "t4g.nano", subnet: "aws_subnet.svc", sgs: ["aws_security_group.svc"] })` with `refs.user_data = ["local.svc_cloud_init"]`; `al2023Instance(c, { key: "monitor", name: "vm-monitor", type: "t4g.nano", subnet: "aws_subnet.nlb", sgs: ["aws_security_group.monitor"] })`.
  `lab-plans.test.mjs` proves it, the scope check included (the S3 flow log, the table's location and the mirror target pass Task 4's clauses; the faults pass every rule: they are a wrong rule and a wrong attribute, not anything outside the lab).

- [ ] **Step 5: Generate the planned graph and the readme diagram**, read them against the diagram list above, add `GOLDEN["ans-28-flow-logs-fix"]` and the id to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-28.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-28-flow-logs-fix`, `npm run labs-topology -- --check ans-28-flow-logs-fix`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/ans-28-flow-logs-fix labs/_learning/ans-28-flow-logs-fix.yaml shared/topology/planned/ans-28-flow-logs-fix.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-28 break-fix: flow logs to CloudWatch and S3 with Athena, a mirror target, NLB client IP preservation and a stateless ACL

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 20: Lab ans-29-multi-region

Spec: §4 (the secondary provider; a second resource group there), §12.2 row 29 (design, implementation; expert; explore; ££ 0.20; peering optional; 15/12; 2/3; prerequisite 21; a TGW and VPC in London and in Ireland, TGW peering attachment and static routes, VPC peering between the same VPCs to compare); §5.1 (the peering attachment `available` after its accept); design sheet "Lab 29"; rulings A87, P1, P3, P15, P18.

**From the design sheet, worth naming:** `tgw-ireland` sets `amazon_side_asn = 64513` (London keeps the default 64512; AWS's peering page recommends a unique ASN per peered transit gateway); and Ireland's instances read `data.aws_ssm_parameter.al2023_ireland` (through `aws.secondary`: AMI ids are regional), which Task 3's `amiProblems` accepts, so `commonAwsProblems` is `[]` (this task never edits `aws-content.mjs`).

**Files:**
- Create: `labs/ans-29-multi-region/lab.yaml`, `readme.md`
- Create: `labs/ans-29-multi-region/terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged), `variables.tf` (the template's header and eight variables: `lab_id`, `name_prefix`, `region`, `secondary_region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `london.tf`, `ireland.tf`, `peering.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/ans-29-multi-region.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-29-multi-region.mjs`
- Create (generated): `shared/topology/planned/ans-29-multi-region.json`, `shared/guides/ans-29-multi-region/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`, `shared/guides/{index,placement}.json` (generated)
- Test: `scripts/test/labs-aws-ans-29.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`AWS_PEER_REGION_LABS = ["ans-29-multi-region"]`); Task 2 (P3: `AcceptVpcPeeringConnection` and `AcceptTransitGatewayPeeringAttachment` change-tag exempt; the VPC accept still meets `VpcFabricNeedsLabTag` on `vpc-ireland`, which carries the lab tag from its create); Task 3 (rule 1: `peer_region` only in this lab and only the session's secondary; the two accepters only through `aws.secondary`; the peering and accepter types); Task 4 (P15: the peering attachment between the lab's own transit gateways, no other account; the accepters of the lab's own peering and attachment by reference; transit gateway routes on a lab transit gateway's default table by reference to its `association_default_route_table_id`); Task 6 (attachments, peering ones seen in both regions deleted once, then transit gateways; the ready check waits on `pendingAcceptance`); Task 10 (attachment and `inter-region peering` edges); batch 3's `realistic.mjs` `providerKey` (lab 16).
- Consumes also Task 3's rule 9 change: its accepter and `peer_region` clauses hold only outside `AWS_PEER_REGION_LABS` (rule 1 judges the region and provider here). Drafted 2026-10-16 before it: the mock plan of this lab was refused by exactly the old rule 9 accepter clause (beside the not-yet-listed transit gateway types).
- Produces nothing other tasks call.

**`labs/ans-29-multi-region/lab.yaml`**
```yaml
# Lab ans-29 (AWS labs batch 4). ANS-C01 ((V) the wording against the current
# exam guide): Network Design (multi-Region connectivity, transit gateway
# peering against VPC peering); Network Implementation (peering attachments,
# accepting across Regions, static transit gateway routes).
# London list prices × 0.75 (labs-verify --aws-prices); Ireland items are
# priced in eu-west-1 (region: secondary). Each side bills its transit
# gateway's attachments by the started hour; whether the peering attachment
# bills on both sides is V (Task 24 reads Cost Explorer), so both are
# counted. Inter-Region data is per GB (authored, light test traffic).
id: ans-29-multi-region
version: 1
cloud: aws
title: "Multi-region: inter-region TGW peering"
summary: >-
  A VPC and a transit gateway in London and in Ireland, joined twice: by a transit gateway peering attachment with
  static routes, and by an inter-Region VPC peering, with one Ireland instance behind each path to compare them.
exam: ANS-C01
skill_areas: [ans.design, ans.implementation]
level: expert
type: explore
prerequisites: [ans-21-transit-gateway]
cost:
  items:
    - name: "Transit gateway attachments in London (VPC and peering), hourly"
      gbp_h: 0.0375
      qty: 2
      whole_hours: true
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { usagetype: "{usage}-TransitGateway-Hours" } }
    - name: "Transit gateway attachments in Ireland (VPC and peering), hourly"
      gbp_h: 0.0375
      qty: 2
      whole_hours: true
      region: secondary
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { usagetype: "{usage}-TransitGateway-Hours" } }
    - { name: "Inter-Region data transfer, light test traffic", gbp_h: 0.0005 }
    - name: "EC2 t4g.nano, Linux (London)"
      gbp_h: 0.0035
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EC2 t4g.nano, Linux (Ireland, 2 running)"
      gbp_h: 0.0034
      qty: 2
      region: secondary
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB (London)"
      gbp_h: 0.0008
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - name: "EBS gp3 root volume, 8 GiB (Ireland)"
      gbp_h: 0.0007
      qty: 2
      region: secondary
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "EC2 Instance Connect Endpoints (London and Ireland)", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 15, destroy_min: 12, session_h: 2, max_h: 3 }
capacity: { instance_types: [t4g.nano, t4g.nano, t4g.nano] }
regions: { secondary: eu-west-1 }
connectivity: { peering: optional, dns_link: false, subnets_used: 2 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/ans-29-multi-region/terraform/london.tf`**
```hcl
# london.tf
#
# Plain English: lab 29's London side. A transit gateway, tgw-london (ASN
# 64512, its default route table on, so vpc-lab's attachment is associated
# and propagated there by itself), attached to vpc-lab in both private
# subnets. rt-private sends each Ireland subnet a different way (ruling
# P18): snet-ireland-tgw's /24 to the transit gateway, snet-ireland-pcx's
# /24 to the VPC peering. Those routes wait for the attachment and the
# accept respectively (peering.tf).

locals {
  ireland_cidr       = cidrsubnet(var.address_space, 2, 1)
  ireland_tgw_subnet = cidrsubnet(local.ireland_cidr, 4, 0)
  ireland_pcx_subnet = cidrsubnet(local.ireland_cidr, 4, 1)
}

resource "aws_ec2_transit_gateway" "london" {
  description                     = "lab ${var.lab_id}: London"
  amazon_side_asn                 = 64512
  auto_accept_shared_attachments  = "disable"
  default_route_table_association = "enable"
  default_route_table_propagation = "enable"
  dns_support                     = "enable"
  tags                            = { Name = "tgw-london" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "london" {
  transit_gateway_id = aws_ec2_transit_gateway.london.id
  vpc_id             = aws_vpc.lab.id
  subnet_ids         = aws_subnet.private[*].id
  tags               = { Name = "tgwa-london" }
}

resource "aws_route" "london_to_ireland_tgw" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = local.ireland_tgw_subnet
  transit_gateway_id     = aws_ec2_transit_gateway.london.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.london]
}

resource "aws_route" "london_to_ireland_pcx" {
  route_table_id            = aws_route_table.private.id
  destination_cidr_block    = local.ireland_pcx_subnet
  vpc_peering_connection_id = aws_vpc_peering_connection.london_ireland.id
  depends_on                = [aws_vpc_peering_connection_accepter.ireland]
}
```

**`labs/ans-29-multi-region/terraform/ireland.tf`**
```hcl
# ireland.tf
#
# Plain English: lab 29's Ireland side (eu-west-1, the session's secondary
# region). The second aws provider, alias secondary, exactly as spec §4
# writes it, and the lab's resource group there (groups are regional). A
# VPC, vpc-ireland (the slot's second /20), with two subnets in two zones,
# each with its own route table back to London's /20: snet-ireland-tgw
# through the Ireland transit gateway, snet-ireland-pcx through the VPC
# peering (ruling P18). A free S3 gateway endpoint on both, an Instance
# Connect Endpoint, eice-ireland, and the transit gateway tgw-ireland (ASN
# 64513: AWS recommends a different ASN on each side of a peering),
# attached in both subnets. The instances read Amazon Linux 2023 from
# Ireland's own copy of the public parameter (AMI ids are regional).

provider "aws" {
  alias  = "secondary"
  region = var.secondary_region
  default_tags {
    tags = var.tags
  }
}

data "aws_availability_zones" "ireland" {
  provider = aws.secondary
  state    = "available"
}

data "aws_ssm_parameter" "al2023_ireland" {
  provider = aws.secondary
  name     = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_resourcegroups_group" "secondary" {
  provider = aws.secondary
  name     = "lab-${var.lab_id}"

  resource_query {
    type = "TAG_FILTERS_1_0"
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters          = [{ Key = "cloudlabs-lab", Values = [var.lab_id] }]
    })
  }
}

resource "aws_vpc" "ireland" {
  provider             = aws.secondary
  cidr_block           = local.ireland_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-ireland" }
}

resource "aws_subnet" "ireland_tgw" {
  provider                = aws.secondary
  vpc_id                  = aws_vpc.ireland.id
  cidr_block              = local.ireland_tgw_subnet
  availability_zone       = data.aws_availability_zones.ireland.names[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-ireland-tgw" }
}

resource "aws_subnet" "ireland_pcx" {
  provider                = aws.secondary
  vpc_id                  = aws_vpc.ireland.id
  cidr_block              = local.ireland_pcx_subnet
  availability_zone       = data.aws_availability_zones.ireland.names[1]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-ireland-pcx" }
}

resource "aws_route_table" "ireland_tgw" {
  provider = aws.secondary
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "rt-ireland-tgw" }
}

resource "aws_route_table" "ireland_pcx" {
  provider = aws.secondary
  vpc_id   = aws_vpc.ireland.id
  tags     = { Name = "rt-ireland-pcx" }
}

resource "aws_route" "ireland_tgw_to_london" {
  provider               = aws.secondary
  route_table_id         = aws_route_table.ireland_tgw.id
  destination_cidr_block = local.vpc_cidr
  transit_gateway_id     = aws_ec2_transit_gateway.ireland.id
  depends_on             = [aws_ec2_transit_gateway_vpc_attachment.ireland]
}

resource "aws_route" "ireland_pcx_to_london" {
  provider                  = aws.secondary
  route_table_id            = aws_route_table.ireland_pcx.id
  destination_cidr_block    = local.vpc_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.london_ireland.id
  depends_on                = [aws_vpc_peering_connection_accepter.ireland]
}

resource "aws_route_table_association" "ireland_tgw" {
  provider       = aws.secondary
  subnet_id      = aws_subnet.ireland_tgw.id
  route_table_id = aws_route_table.ireland_tgw.id
}

resource "aws_route_table_association" "ireland_pcx" {
  provider       = aws.secondary
  subnet_id      = aws_subnet.ireland_pcx.id
  route_table_id = aws_route_table.ireland_pcx.id
}

resource "aws_vpc_endpoint" "ireland_s3" {
  provider          = aws.secondary
  vpc_id            = aws_vpc.ireland.id
  service_name      = "com.amazonaws.${var.secondary_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.ireland_tgw.id, aws_route_table.ireland_pcx.id]
  tags              = { Name = "vpce-s3-ireland" }
}

resource "aws_security_group" "eice_ireland" {
  provider    = aws.secondary
  name        = "lab-eice-ireland"
  description = "Instance Connect Endpoint in Ireland: SSH out to the Ireland instances"
  vpc_id      = aws_vpc.ireland.id
  tags        = { Name = "sg-eice-ireland" }
}

resource "aws_vpc_security_group_egress_rule" "eice_ireland_ssh" {
  provider          = aws.secondary
  security_group_id = aws_security_group.eice_ireland.id
  cidr_ipv4         = local.ireland_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "ireland" {
  provider           = aws.secondary
  subnet_id          = aws_subnet.ireland_tgw.id
  security_group_ids = [aws_security_group.eice_ireland.id]
  preserve_client_ip = false
  tags               = { Name = "eice-ireland" }
}

resource "aws_ec2_transit_gateway" "ireland" {
  provider                        = aws.secondary
  description                     = "lab ${var.lab_id}: Ireland"
  amazon_side_asn                 = 64513
  auto_accept_shared_attachments  = "disable"
  default_route_table_association = "enable"
  default_route_table_propagation = "enable"
  dns_support                     = "enable"
  tags                            = { Name = "tgw-ireland" }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "ireland" {
  provider           = aws.secondary
  transit_gateway_id = aws_ec2_transit_gateway.ireland.id
  vpc_id             = aws_vpc.ireland.id
  subnet_ids         = [aws_subnet.ireland_tgw.id, aws_subnet.ireland_pcx.id]
  tags               = { Name = "tgwa-ireland" }
}
```

**`labs/ans-29-multi-region/terraform/peering.tf`**
```hcl
# peering.tf
#
# Plain English: lab 29's two inter-region paths between the same VPCs
# (rulings P3, P15, P18). London asks for both: a transit gateway peering
# attachment from tgw-london to tgw-ireland, and a VPC peering from vpc-lab
# to vpc-ireland. Ireland accepts both through the secondary provider (an
# inter-region request is never accepted automatically; ruling P3 lets the
# lab role accept a peering whose Ireland side carries no lab tag until the
# accepter tags it). A transit gateway peering never propagates routes, so
# each side's default route table gets a static route to the other side's
# /20 through the peering attachment, once it is accepted.

resource "aws_ec2_transit_gateway_peering_attachment" "london_ireland" {
  transit_gateway_id      = aws_ec2_transit_gateway.london.id
  peer_region             = var.secondary_region
  peer_transit_gateway_id = aws_ec2_transit_gateway.ireland.id
  tags                    = { Name = "tgwp-london-ireland" }
}

resource "aws_ec2_transit_gateway_peering_attachment_accepter" "ireland" {
  provider                      = aws.secondary
  transit_gateway_attachment_id = aws_ec2_transit_gateway_peering_attachment.london_ireland.id
  tags                          = { Name = "tgwp-london-ireland" }
}

resource "aws_ec2_transit_gateway_route" "london_to_ireland" {
  destination_cidr_block         = local.ireland_cidr
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment.london_ireland.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway.london.association_default_route_table_id
  depends_on                     = [aws_ec2_transit_gateway_peering_attachment_accepter.ireland]
}

resource "aws_ec2_transit_gateway_route" "ireland_to_london" {
  provider                       = aws.secondary
  destination_cidr_block         = local.vpc_cidr
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment_accepter.ireland.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway.ireland.association_default_route_table_id
}

resource "aws_vpc_peering_connection" "london_ireland" {
  vpc_id      = aws_vpc.lab.id
  peer_vpc_id = aws_vpc.ireland.id
  peer_region = var.secondary_region
  auto_accept = false
  tags        = { Name = "pcx-london-ireland" }
}

resource "aws_vpc_peering_connection_accepter" "ireland" {
  provider                  = aws.secondary
  vpc_peering_connection_id = aws_vpc_peering_connection.london_ireland.id
  auto_accept               = true
  tags                      = { Name = "pcx-london-ireland" }
}
```

**`labs/ans-29-multi-region/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 29's three test instances (t4g.nano, Amazon Linux
# 2023), each serving a page naming itself: vm-london in snet-private-1, and
# in Ireland vm-ireland-tgw (reached from London through the transit
# gateways) and vm-ireland-pcx (reached through the VPC peering). The
# template's sg-vms gains ping and HTTP from Ireland's /20; Ireland's
# sg-vms-ireland admits ping and HTTP from London's /20 and SSH from
# eice-ireland. Security groups cannot name each other across regions, so
# these rules use ranges.

locals {
  web_unit = {
    path        = "/etc/systemd/system/lab-web.service"
    permissions = "0644"
    content     = join("\n", ["[Unit]", "Description=Lab page on port 80", "After=network-online.target", "[Service]", "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www", "Restart=always", "[Install]", "WantedBy=multi-user.target", ""])
  }
  web_runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
}

resource "aws_vpc_security_group_ingress_rule" "vms_icmp_ireland" {
  security_group_id = aws_security_group.vms.id
  cidr_ipv4         = local.ireland_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "vms_http_ireland" {
  security_group_id = aws_security_group.vms.id
  cidr_ipv4         = local.ireland_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_security_group" "vms_ireland" {
  provider    = aws.secondary
  name        = "lab-vms-ireland"
  description = "Ireland instances: ping and HTTP from London, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.ireland.id
  tags        = { Name = "sg-vms-ireland" }
}

resource "aws_vpc_security_group_ingress_rule" "ireland_icmp_london" {
  provider          = aws.secondary
  security_group_id = aws_security_group.vms_ireland.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "ireland_http_london" {
  provider          = aws.secondary
  security_group_id = aws_security_group.vms_ireland.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "ireland_ssh_eice" {
  provider                     = aws.secondary
  security_group_id            = aws_security_group.vms_ireland.id
  referenced_security_group_id = aws_security_group.eice_ireland.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "ireland_all" {
  provider          = aws.secondary
  security_group_id = aws_security_group.vms_ireland.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "london" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/srv/www/index.html", permissions = "0644", content = "vm-london in vpc-lab (London)\n" }, local.web_unit]
    runcmd      = local.web_runcmd
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-london" })
  tags        = { Name = "vm-london" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_instance" "ireland_tgw" {
  provider               = aws.secondary
  ami                    = data.aws_ssm_parameter.al2023_ireland.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.ireland_tgw.id
  vpc_security_group_ids = [aws_security_group.vms_ireland.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/srv/www/index.html", permissions = "0644", content = "vm-ireland-tgw in vpc-ireland, reached by the transit gateways\n" }, local.web_unit]
    runcmd      = local.web_runcmd
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-ireland-tgw" })
  tags        = { Name = "vm-ireland-tgw" }
  depends_on  = [aws_vpc_endpoint.ireland_s3]
}

resource "aws_instance" "ireland_pcx" {
  provider               = aws.secondary
  ami                    = data.aws_ssm_parameter.al2023_ireland.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.ireland_pcx.id
  vpc_security_group_ids = [aws_security_group.vms_ireland.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/srv/www/index.html", permissions = "0644", content = "vm-ireland-pcx in vpc-ireland, reached by the VPC peering\n" }, local.web_unit]
    runcmd      = local.web_runcmd
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-ireland-pcx" })
  tags        = { Name = "vm-ireland-pcx" }
  depends_on  = [aws_vpc_endpoint.ireland_s3]
}
```

**`labs/ans-29-multi-region/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 29 is up: the three
# instances' addresses, console SSH to each (the Ireland ones with
# --region eu-west-1), the two pings that compare the paths from London,
# and, while peered, SSH and the page on vm-london. Only vpc-lab is peered
# to the VPN server.

output "private_ips" {
  value = { "vm-london" = aws_instance.london.private_ip, "vm-ireland-tgw" = aws_instance.ireland_tgw.private_ip, "vm-ireland-pcx" = aws_instance.ireland_pcx.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.london.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --region ${var.secondary_region} --instance-id ${aws_instance.ireland_tgw.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --region ${var.secondary_region} --instance-id ${aws_instance.ireland_pcx.id} --os-user labadmin --connection-type eice",
    "From vm-london: ping -c 10 ${aws_instance.ireland_tgw.private_ip} (by the transit gateways), ping -c 10 ${aws_instance.ireland_pcx.private_ip} (by the VPC peering)",
    "ssh labadmin@${aws_instance.london.private_ip}",
    "curl http://${aws_instance.london.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

(V) for Task 24, read on the release test and recorded: the accepter side's tags (P3's exemption covers either answer: `aws ec2 describe-transit-gateway-peering-attachments --region eu-west-1` after the accept shows the lab tag); each peering attachment is associated with its side's default route table once accepted (default association is on; `aws ec2 get-transit-gateway-attachment-propagations` is empty for it, `get-transit-gateway-route-table-associations` on each default table lists it; if it is not associated, traffic from the other side is dropped though the release test still passes, and the fix is the fallback below, in `peering.tf`, with a version bump); deploy inside 15 minutes; whether the peering attachment bills on both sides (Cost Explorer, `TransitGateway-Hours` by region, the day after).

The fallback, written only if the release test shows the peering attachment unassociated (Task 4 already allows both: the lab's own attachment or accepter on its own transit gateway's default table, by reference; the test gains a `resources(lab, "aws_ec2_transit_gateway_route_table_association")` count of 2, and the fixture the two blocks):
```hcl
# Fallback (V): AWS left the accepted peering attachment off each side's default route table.
resource "aws_ec2_transit_gateway_route_table_association" "london_peering" {
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment.london_ireland.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway.london.association_default_route_table_id
  depends_on                     = [aws_ec2_transit_gateway_peering_attachment_accepter.ireland]
}

resource "aws_ec2_transit_gateway_route_table_association" "ireland_peering" {
  provider                       = aws.secondary
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment_accepter.ireland.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway.ireland.association_default_route_table_id
}
```

**`labs/ans-29-multi-region/readme.md`** (exactly):
````markdown
Two ways to join a VPC in London to one in Ireland, side by side: a transit gateway in each Region joined by a peering attachment, and a plain inter-Region VPC peering. One Ireland instance sits behind each path, so you can ping both from London and compare. Everything is listed in the lab's resource groups, `lab-ans-29-multi-region`, in AWS Resource Groups (London and Ireland).
From the ANS-C01 outline: design and implement connectivity across AWS Regions with transit gateway peering and VPC peering, and choose between them.

## What it deploys

- **London**: the VPC `vpc-lab` with `vm-london` (t4g.nano) in `snet-private-1`, and the transit gateway `tgw-london` (ASN 64512) attached to it (`tgwa-london`). Its route table `rt-private` sends `snet-ireland-tgw`'s /24 to `tgw-london` and `snet-ireland-pcx`'s /24 to the VPC peering
- **Ireland**: the VPC `vpc-ireland` (the slot's second /20) with two subnets, each with its own route table back to London's /20: `snet-ireland-tgw` (`rt-ireland-tgw`, through `tgw-ireland`) holding `vm-ireland-tgw`, and `snet-ireland-pcx` (`rt-ireland-pcx`, through the VPC peering) holding `vm-ireland-pcx`; the transit gateway `tgw-ireland` (ASN 64513) attached in both subnets (`tgwa-ireland`); an S3 gateway endpoint and the Instance Connect Endpoint `eice-ireland`
- **Transit gateway peering**: the peering attachment `tgwp-london-ireland`, requested in London and accepted in Ireland; a transit gateway peering never learns routes, so each side's default route table has a static route to the other side's /20 through it
- **VPC peering**: `pcx-london-ireland`, requested in London and accepted in Ireland (an inter-Region request is never accepted automatically)

It takes up to a quarter of an hour: each peering waits for its accept, and the transit gateways and their attachments take a few minutes each.

```text
lab-ans-29-multi-region
  London: vm-london (vpc-lab) -- rt-private --+-- snet-ireland-tgw /24 --> tgw-london
                                              +-- snet-ireland-pcx /24 --> pcx-london-ireland
  tgw-london <== tgwp-london-ireland (static routes both sides) ==> tgw-ireland (Ireland)
  Ireland: tgw-ireland --> vm-ireland-tgw (snet-ireland-tgw, rt-ireland-tgw)
  Ireland: pcx-london-ireland --> vm-ireland-pcx (snet-ireland-pcx, rt-ireland-pcx)
  peering (optional, AWS server only, vpc-lab only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Connect to `vm-london` (the first Connect line) and run the fourth line's two pings. Compare the round-trip times: both cross the Irish Sea on AWS's network, one through two transit gateways and one directly. Run `curl` against both instances' addresses too: each page says which path it was reached by.
- In the VPC console (London), open Transit gateway route tables and `tgw-london`'s default table: London's /20 is **propagated** from `tgwa-london`, Ireland's /20 is a **static** route to the peering attachment. Switch the console to Ireland (eu-west-1) and look at `tgw-ireland`'s table: the mirror image.
- Break the transit gateway path: in Ireland, delete the static route to London's /20 from `tgw-ireland`'s default table. The ping to `vm-ireland-tgw` stops; the one to `vm-ireland-pcx` carries on. Add the route back (London's /20, attachment `tgwp-london-ireland`).
- Connect to `vm-ireland-tgw` (the second Connect line, note `--region`) and `curl` `vm-london`'s address: the reply takes the same path back, because London's route table names this /24 explicitly.
- Weigh the two: a transit gateway charges for each attachment hour on both sides and for every GB it processes, but joins many VPCs and Regions with one hub; VPC peering has no hourly charge and no processing charge, only the inter-Region data, but every pair of VPCs needs its own peering and peering is never transitive.

## Learn more

- [Transit gateway peering attachments](https://docs.aws.amazon.com/vpc/latest/tgw/tgw-peering.html)
- [Add a route to a transit gateway route table for a peering attachment](https://docs.aws.amazon.com/vpc/latest/tgw/tgw-peering-add-route.html)
- [Inter-Region VPC peering](https://docs.aws.amazon.com/vpc/latest/peering/what-is-vpc-peering.html)
- [Transit gateway design best practices](https://docs.aws.amazon.com/vpc/latest/tgw/tgw-best-design-practices.html)
- [Amazon VPC-to-Amazon VPC connectivity options](https://docs.aws.amazon.com/whitepapers/latest/aws-vpc-connectivity-options/amazon-vpc-to-amazon-vpc-connectivity-options.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-29-multi-region` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-29-multi-region.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Join London and Ireland VPCs by transit gateway peering and by VPC peering, and compare them.
learn:
  - Peer transit gateways across Regions with static routes
  - Accept inter-Region peering requests in the other Region
  - Compare the two paths for latency, reach and cost
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-ans-29-multi-region · London` and `resourceGroup lab-ans-29-multi-region · Ireland`; `vnet vpc-lab` (London; `subnet snet-private-1/2`) and `vnet vpc-ireland` (Ireland; `subnet snet-ireland-tgw`, `snet-ireland-pcx`); `transitGateway tgw-london < lab-ans-29-multi-region · London`, `transitGateway tgw-ireland < lab-ans-29-multi-region · Ireland` (attachments, the peering accepter and the static routes fold in); `routeTable rt-private < vpc-lab`, `routeTable rt-ireland-tgw`, `rt-ireland-pcx` (`< vpc-ireland`); `nsg sg-eice`, `sg-vms` (`< vpc-lab`), `sg-eice-ireland`, `sg-vms-ireland` (`< vpc-ireland`); `vm vm-london < snet-private-1`, `vm vm-ireland-tgw < snet-ireland-tgw`, `vm vm-ireland-pcx < snet-ireland-pcx`; `bastion eice-lab < snet-private-1`, `bastion eice-ireland < snet-ireland-tgw`; `privateEndpoint vpce-s3 < vpc-lab`, `privateEndpoint vpce-s3-ireland < vpc-ireland`. Edges: `tgw-london ..> vpc-lab : attachment`, `tgw-ireland ..> vpc-ireland : attachment`, `tgw-london ..> tgw-ireland : inter-region peering`, `vpc-lab -> vpc-ireland : peering` (the VPC peering's own edge; its accepter folds into it).

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-ans-29.test.mjs`:

```js
// labs-aws-ans-29.test.mjs
//
// Plain English: lab ans-29-multi-region is the lab AWS labs spec §12.2
// row 29 describes: a transit gateway and a VPC in London and in Ireland,
// joined by a transit gateway peering attachment with static routes and by
// an inter-Region VPC peering between the same VPCs, one Ireland instance
// behind each path (rulings P1, P3, P15, P18).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_DNS_LABS, AWS_GLOBAL_LABS, AWS_PEER_REGION_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "ans-29-multi-region";
const of = (blocks, type) => blocks.filter((b) => b.kind === "resource" && b.labels[0] === type);
const body = (blocks, type, name) => of(blocks, type).find((b) => b.labels[1] === name)?.body ?? "";

test("ans-29 keeps the AWS lab contract; Ireland's instances read Ireland's copy of the AL2023 parameter (Task 3's amiProblems)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  const { blocks } = awsLab(ID);
  const param = blocks.find((b) => b.kind === "data" && b.labels[1] === "al2023_ireland").body;
  assert.match(param, /provider = aws\.secondary\n\s+name\s+= "\/aws\/service\/ami-amazon-linux-latest\/al2023-ami-kernel-default-arm64"/);
  for (const k of ["ireland_tgw", "ireland_pcx"]) assert.match(body(blocks, "aws_instance", k), /ami\s+= data\.aws_ssm_parameter\.al2023_ireland\.insecure_value/, k);
});

test("ruling P1: ans-29 is the one peer-region lab; Ireland is its secondary region", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual(yaml.regions, { secondary: "eu-west-1" });
  assert.deepEqual(AWS_PEER_REGION_LABS, [ID]);
  assert.ok(!AWS_GLOBAL_LABS.includes(ID) && !AWS_DNS_LABS.includes(ID));
});

test("ans-29's lab.yaml: §12.2 row 29, after lab 21, about £0.16/h with four attachments billed by the whole hour (two in Ireland)", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.implementation"], ["ans-21-transit-gateway"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 15, destroy_min: 12, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.15 && total < 0.18, `about £0.163/h, got ${total}`);
  const tgw = yaml.cost.items.filter((i) => i.aws_price?.filters.usagetype === "{usage}-TransitGateway-Hours");
  assert.deepEqual(tgw.map((i) => [i.qty, i.whole_hours, i.region ?? "london"]), [[2, true, "london"], [2, true, "secondary"]]);
  assert.equal(yaml.cost.items.filter((i) => i.region === "secondary").length, 3);
});

test("ans-29's Ireland: the secondary provider exactly as §4, its own resource group, VPC in the slot's second /20, every resource through aws.secondary", () => {
  const { files, blocks } = awsLab(ID);
  const ie = files["ireland.tf"];
  assert.match(ie, /provider "aws" \{\n  alias  = "secondary"\n  region = var\.secondary_region\n  default_tags \{\n    tags = var\.tags\n  \}\n\}/);
  assert.match(files["london.tf"], /ireland_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/);
  const inIreland = blocks.filter((b) => (b.kind === "resource" || b.kind === "data") && ie.includes(`"${b.labels[0]}" "${b.labels[1]}" {`));
  assert.equal(inIreland.length, 18, "2 data sources and 16 resources");
  for (const b of inIreland) assert.match(b.body, /^\s*provider\s+= aws\.secondary$/m, `${b.labels.join(".")}`);
  for (const k of ["ireland_tgw", "ireland_pcx", "vms_ireland"]) assert.match(body(blocks, k === "vms_ireland" ? "aws_security_group" : "aws_instance", k), /provider\s+= aws\.secondary/, k);
  for (const re of [/amazon_side_asn\s+= 64513/, /default_route_table_association = "enable"/, /default_route_table_propagation = "enable"/, /auto_accept_shared_attachments\s+= "disable"/]) assert.match(body(blocks, "aws_ec2_transit_gateway", "ireland"), re);
  assert.match(body(blocks, "aws_ec2_transit_gateway", "london"), /amazon_side_asn\s+= 64512/);
});

test("rulings P3, P15 and P18: London requests both peerings to Ireland, Ireland accepts both through aws.secondary, static routes wait for the accept", () => {
  const { blocks } = awsLab(ID);
  const tgwp = body(blocks, "aws_ec2_transit_gateway_peering_attachment", "london_ireland");
  for (const re of [/transit_gateway_id\s+= aws_ec2_transit_gateway\.london\.id/, /peer_region\s+= var\.secondary_region/, /peer_transit_gateway_id = aws_ec2_transit_gateway\.ireland\.id/]) assert.match(tgwp, re);
  assert.doesNotMatch(tgwp, /provider|peer_account_id/);
  const tgwa = body(blocks, "aws_ec2_transit_gateway_peering_attachment_accepter", "ireland");
  for (const re of [/provider\s+= aws\.secondary/, /transit_gateway_attachment_id = aws_ec2_transit_gateway_peering_attachment\.london_ireland\.id/]) assert.match(tgwa, re);
  const l2i = body(blocks, "aws_ec2_transit_gateway_route", "london_to_ireland");
  for (const re of [/destination_cidr_block\s+= local\.ireland_cidr/, /aws_ec2_transit_gateway\.london\.association_default_route_table_id/, /depends_on\s+= \[aws_ec2_transit_gateway_peering_attachment_accepter\.ireland\]/]) assert.match(l2i, re);
  const i2l = body(blocks, "aws_ec2_transit_gateway_route", "ireland_to_london");
  for (const re of [/provider\s+= aws\.secondary/, /destination_cidr_block\s+= local\.vpc_cidr/, /transit_gateway_attachment_id\s+= aws_ec2_transit_gateway_peering_attachment_accepter\.ireland\.id/, /aws_ec2_transit_gateway\.ireland\.association_default_route_table_id/]) assert.match(i2l, re);
  const pcx = body(blocks, "aws_vpc_peering_connection", "london_ireland");
  for (const re of [/vpc_id\s+= aws_vpc\.lab\.id/, /peer_vpc_id = aws_vpc\.ireland\.id/, /peer_region = var\.secondary_region/, /auto_accept = false/]) assert.match(pcx, re);
  assert.doesNotMatch(pcx, /peer_owner_id/);
  for (const re of [/provider\s+= aws\.secondary/, /vpc_peering_connection_id = aws_vpc_peering_connection\.london_ireland\.id/, /auto_accept\s+= true/]) assert.match(body(blocks, "aws_vpc_peering_connection_accepter", "ireland"), re);
});

test("ruling P18: each Ireland subnet is reached one way and answers the same way", () => {
  const { blocks } = awsLab(ID);
  for (const re of [/destination_cidr_block = local\.ireland_tgw_subnet/, /transit_gateway_id\s+= aws_ec2_transit_gateway\.london\.id/, /depends_on\s+= \[aws_ec2_transit_gateway_vpc_attachment\.london\]/]) assert.match(body(blocks, "aws_route", "london_to_ireland_tgw"), re);
  for (const re of [/destination_cidr_block\s+= local\.ireland_pcx_subnet/, /vpc_peering_connection_id = aws_vpc_peering_connection\.london_ireland\.id/, /depends_on\s+= \[aws_vpc_peering_connection_accepter\.ireland\]/]) assert.match(body(blocks, "aws_route", "london_to_ireland_pcx"), re);
  for (const re of [/route_table_id\s+= aws_route_table\.ireland_tgw\.id/, /transit_gateway_id\s+= aws_ec2_transit_gateway\.ireland\.id/]) assert.match(body(blocks, "aws_route", "ireland_tgw_to_london"), re);
  for (const re of [/route_table_id\s+= aws_route_table\.ireland_pcx\.id/, /vpc_peering_connection_id = aws_vpc_peering_connection\.london_ireland\.id/]) assert.match(body(blocks, "aws_route", "ireland_pcx_to_london"), re);
  assert.match(body(blocks, "aws_ec2_transit_gateway_vpc_attachment", "ireland"), /subnet_ids\s+= \[aws_subnet\.ireland_tgw\.id, aws_subnet\.ireland_pcx\.id\]/);
});

test("ans-29's readme compares the two paths, and its learning content is valid", () => {
  const { readme, learning, yaml, files } = awsLab(ID);
  for (const s of ["tgwp-london-ireland", "pcx-london-ireland", "static", "propagated", "eu-west-1", "never transitive"]) assert.ok(readme.includes(s), s);
  assert.match(files["outputs.tf"], /--region \$\{var\.secondary_region\} --instance-id \$\{aws_instance\.ireland_tgw\.id\}/);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-ans-29.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; trim `variables.tf` to the eight variables named.

- [ ] **Step 4: Write the plan fixture** `ans-29-multi-region.mjs`, as saa-16's two-region fixture: `const c = ctxAws("ans-29-multi-region", "29")`, `const IE = "aws.secondary"`, `const ie = cidrsubnet(c.address, 2, 1)`, `const ieTgw = cidrsubnet(ie, 4, 0)`, `const iePcx = cidrsubnet(ie, 4, 1)`, `const AMI_IE = "ami-0fedcba9876543210"`; `variables: { ...c.variables, secondary_region: AWS_SECONDARY }`; `providerConfig: { ...AWS_PROVIDER_CONFIG, "aws.secondary": <saa-16's SECONDARY_PROVIDER_CONFIG entry> }`; `data: [...awsData(), { address: "data.aws_availability_zones.ireland", providerKey: IE, values: { state: "available", names: ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }, args: ["state"], refs: {} }, { address: "data.aws_ssm_parameter.al2023_ireland", providerKey: IE, values: { name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64", insecure_value: AMI_IE }, args: ["name"], refs: {} }]`; `resources: [...templateResources(c), …]`, every `ireland.tf` resource, both accepters, `aws_ec2_transit_gateway_route.ireland_to_london`, `aws_security_group.vms_ireland` and its four rules and the two Ireland instances with `providerKey: IE`:
  - `london.tf`: `aws_ec2_transit_gateway.london` { `description: "lab ans-29-multi-region: London"`, `amazon_side_asn: 64512`, `auto_accept_shared_attachments: "disable"`, `default_route_table_association: "enable"`, `default_route_table_propagation: "enable"`, `dns_support: "enable"`, `tgw-london` } refs `description: ["var.lab_id"]`; `aws_ec2_transit_gateway_vpc_attachment.london` (`tgwa-london`, unknown `transit_gateway_id`, `vpc_id`, `subnet_ids` with refs `["aws_subnet.private"]`); `aws_route.london_to_ireland_tgw` { `destination_cidr_block: ieTgw` } refs `["local.ireland_tgw_subnet"]`, unknown `route_table_id`, `transit_gateway_id`; `aws_route.london_to_ireland_pcx` { `destination_cidr_block: iePcx` } refs `["local.ireland_pcx_subnet"]`, unknown `vpc_peering_connection_id` (ref `aws_vpc_peering_connection.london_ireland`).
  - `ireland.tf`: the resource group `secondary` (as saa-16's); `aws_vpc.ireland` (`ie`, `vpc-ireland`, refs `["local.ireland_cidr"]`); `aws_subnet.ireland_tgw` (`ieTgw`, `eu-west-1a`, refs `availability_zone: ["data.aws_availability_zones.ireland.names[0]", "data.aws_availability_zones.ireland.names", "data.aws_availability_zones.ireland"]`) and `.ireland_pcx` (`iePcx`, `eu-west-1b`, `names[1]`); `aws_route_table.ireland_tgw`, `.ireland_pcx`; `aws_route.ireland_tgw_to_london` and `.ireland_pcx_to_london` { `destination_cidr_block: c.vpcCidr` } refs `["local.vpc_cidr"]`, unknown target (`transit_gateway_id` ref `aws_ec2_transit_gateway.ireland`; `vpc_peering_connection_id`); the two associations; `aws_vpc_endpoint.ireland_s3` (`com.amazonaws.eu-west-1.s3`, refs `service_name: ["var.secondary_region"]`, unknown `route_table_ids`); `aws_security_group.eice_ireland` (`lab-eice-ireland`) and its egress rule (`cidr_ipv4: ie`); `aws_ec2_instance_connect_endpoint.ireland` (ref `aws_subnet.ireland_tgw`); `aws_ec2_transit_gateway.ireland` (as London's with `amazon_side_asn: 64513`, `"lab ans-29-multi-region: Ireland"`, `tgw-ireland`); `aws_ec2_transit_gateway_vpc_attachment.ireland` (`tgwa-ireland`, unknown `subnet_ids` with refs `["aws_subnet.ireland_tgw.id", "aws_subnet.ireland_tgw", "aws_subnet.ireland_pcx.id", "aws_subnet.ireland_pcx"]`).
  - `peering.tf`: `aws_ec2_transit_gateway_peering_attachment.london_ireland` { `peer_region: "eu-west-1"`, `tgwp-london-ireland` } refs `peer_region: ["var.secondary_region"]`, unknown `transit_gateway_id` (ref London's), `peer_transit_gateway_id` (ref Ireland's); `aws_ec2_transit_gateway_peering_attachment_accepter.ireland` (tagged, Name `tgwp-london-ireland`, unknown `transit_gateway_attachment_id`); `aws_ec2_transit_gateway_route.london_to_ireland` { `destination_cidr_block: ie` } refs `["local.ireland_cidr"]`, unknown `transit_gateway_attachment_id` (ref the attachment) and `transit_gateway_route_table_id` (ref `aws_ec2_transit_gateway.london` `association_default_route_table_id`); `.ireland_to_london` { `destination_cidr_block: c.vpcCidr` } with the accepter's `id` and Ireland's default table; `aws_vpc_peering_connection.london_ireland` { `peer_region: "eu-west-1"`, `auto_accept: false`, `pcx-london-ireland` } refs `peer_region: ["var.secondary_region"]`, unknown `vpc_id`, `peer_vpc_id` (refs `aws_vpc.lab`, `aws_vpc.ireland`); `aws_vpc_peering_connection_accepter.ireland` { `auto_accept: true`, Name `pcx-london-ireland` } unknown `vpc_peering_connection_id`.
  - `compute.tf`: `vms_icmp_ireland`, `vms_http_ireland` on `aws_security_group.vms` (`cidr_ipv4: ie`, refs `["local.ireland_cidr"]`); `aws_security_group.vms_ireland` (`lab-vms-ireland`) with `ireland_icmp_london`, `ireland_http_london` (`cidr_ipv4: c.vpcCidr`), `ireland_ssh_eice`, `ireland_all`; `al2023Instance(c, { key: "london", name: "vm-london", type: "t4g.nano" })`; `al2023Instance(c, { key: "ireland_tgw", name: "vm-ireland-tgw", subnet: "aws_subnet.ireland_tgw", type: "t4g.nano", sgs: ["aws_security_group.vms_ireland"] })` and `ireland_pcx` likewise, each with `providerKey: IE`, `values.ami = AMI_IE`, `refs.ami = ["data.aws_ssm_parameter.al2023_ireland.insecure_value", "data.aws_ssm_parameter.al2023_ireland"]`; all three with `refs.user_data = ["local.cloud_init_base", "local.web_unit", "local.web_runcmd"]`.

  `lab-plans.test.mjs` proves it, the scope check included (rule 1's peer-region and accepter clauses, rule 9 as Task 3 leaves it).

- [ ] **Step 5: Generate the planned graph and the readme diagram**, check it against "The diagram" above, `GOLDEN["ans-29-multi-region"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-29.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-29-multi-region`, `npm run labs-topology -- --check ans-29-multi-region`, `npm run labs-diagrams -- --check`
Expected: all PASS (labs-tf's mock plan sets `secondary_region`). (Drafted 2026-10-16: fmt, validate, lint pass; this test passes with `AWS_PEER_REGION_LABS` shimmed as Task 1 writes it; the mock plan applies and its scope check refuses only the transit gateway types Task 3 adds and rule 9's accepter clause, above.)

- [ ] **Step 7: Commit**

```bash
git add labs/ans-29-multi-region labs/_learning/ans-29-multi-region.yaml shared/topology/planned/ans-29-multi-region.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-29 multi-region: transit gateway peering and VPC peering between London and Ireland, side by side

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 21: Lab ans-30-vpc-lattice

Spec: §12.2 row 30 (design, security; expert; explore; £ 0.05; peering optional; 6/5; 2/4; prerequisite 24; service network, two services with instance targets in two VPCs, IAM auth policy, a client signing with SigV4); §7.2 (`vpc-lattice-svcs` in the boundary); §7.5 (a VPC passed as a parameter); rulings A42, A45, P7, P19, P21, P23. Design sheet: Lab 30.

**Files:**
- Create: `labs/ans-30-vpc-lattice/lab.yaml`, `readme.md`
- Create: `labs/ans-30-vpc-lattice/terraform/versions.tf`, `main.tf`, `network.tf` (all three copied unchanged from `labs/_template-aws/`), `variables.tf` (the template's header and its `lab_id`, `region`, `address_space`, `gateway_cidr`, `admin_password` and `tags` blocks, verbatim), `svc-b-vpc.tf`, `iam.tf`, `lattice.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/ans-30-vpc-lattice.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-30-vpc-lattice.mjs`
- Create (generated): `shared/topology/planned/ans-30-vpc-lattice.json`, `shared/guides/ans-30-vpc-lattice/**`
- Modify: `shared/guides/{index,placement}.json` (generated), `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-ans-30.test.mjs`

**Interfaces:**
- Consumes: Task 2 (`vpc-lattice:Create*` creates; `RegisterTargets` and `PutAuthPolicy` changes; `vpc-lattice` made ahead already); Task 3 (the eight Lattice types on `AWS_TYPES`; `aws_vpclattice_auth_policy` on `RESOURCE_POLICIES`, read for who it lets in: known at plan, an `AWS` principal only in the plan's account); Task 4 (`batch4Problems`: the VPC association's VPC and groups, the service association's service and network, the target group's VPC and `INSTANCE` type, the targets and the auth policy's resource, all the lab's own by reference); Task 5 (Lattice clean-up in P23's order, associations waited for); Task 10 (`lattice` cards, the `service` edges from the network, the `associated` edge from `vpc-lab`, the `HTTP` edges from each service to its instance; listeners, target groups, attachments, associations and auth policies folded). The ready check's existing Lattice cases (services and both kinds of association `ACTIVE`) are what "ready" waits for.

**`labs/ans-30-vpc-lattice/lab.yaml`**
```yaml
# Lab ans-30 (AWS labs batch 4). ANS-C01 ((V) the wording against the current
# exam guide): Network Design (service-to-service connectivity across VPCs
# without peering); Network Security, Compliance, and Governance (IAM auth
# policies, SigV4-signed requests).
# London list prices × 0.75 (labs-verify --aws-prices). VPC Lattice bills
# each service by the hour ($0.025 each, V: AWS's price list has no single
# regional hourly product the verifier can match, so authored) and requests
# and data per use (authored).
id: ans-30-vpc-lattice
version: 1
cloud: aws
title: "VPC Lattice service network with auth policies"
summary: >-
  A VPC Lattice service network joins two HTTP services whose instances sit in two different VPCs, with no peering
  and no routes between them. A client signs its requests with its instance role (SigV4), and IAM auth policies on the
  network and on each service decide who may call what.
exam: ANS-C01
skill_areas: [ans.design, ans.security]
level: expert
type: explore
prerequisites: [ans-24-privatelink]
cost:
  items:
    - { name: "VPC Lattice services (2, $0.025 an hour each)", gbp_h: 0.0188, qty: 2 }
    - { name: "Lattice requests and data, light test traffic", gbp_h: 0.0001 }
    - name: "EC2 t4g.nano, Linux (vm-client, vm-svc-a and vm-svc-b)"
      gbp_h: 0.0035
      qty: 3
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 3
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "EC2 Instance Connect Endpoints (2)", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 6, destroy_min: 5, session_h: 2, max_h: 4 }
capacity: { instance_types: [t4g.nano, t4g.nano, t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 2 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`labs/ans-30-vpc-lattice/terraform/svc-b-vpc.tf`**
```hcl
# svc-b-vpc.tf
#
# Plain English: lab 30's second VPC, vpc-svc-b (the slot's second /20),
# where service B's instance runs. Two private subnets in two Availability
# Zones, a route table with no route to vpc-lab (VPC Lattice needs none), a
# free S3 gateway endpoint, and its own Instance Connect Endpoint for console
# SSH to vm-svc-b.

locals {
  svc_b_cidr = cidrsubnet(var.address_space, 2, 1)
}

resource "aws_vpc" "svc_b" {
  cidr_block           = local.svc_b_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-svc-b" }
}

resource "aws_subnet" "svc_b" {
  count                   = 2
  vpc_id                  = aws_vpc.svc_b.id
  cidr_block              = cidrsubnet(local.svc_b_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-svc-b-${count.index + 1}" }
}

resource "aws_route_table" "svc_b" {
  vpc_id = aws_vpc.svc_b.id
  tags   = { Name = "rt-svc-b" }
}

resource "aws_route_table_association" "svc_b" {
  count          = 2
  subnet_id      = aws_subnet.svc_b[count.index].id
  route_table_id = aws_route_table.svc_b.id
}

resource "aws_vpc_endpoint" "svc_b_s3" {
  vpc_id            = aws_vpc.svc_b.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.svc_b.id]
  tags              = { Name = "vpce-s3-svc-b" }
}

resource "aws_security_group" "eice_svc_b" {
  name        = "lab-eice-svc-b"
  description = "Instance Connect Endpoint in vpc-svc-b: SSH out to vm-svc-b"
  vpc_id      = aws_vpc.svc_b.id
  tags        = { Name = "sg-eice-svc-b" }
}

resource "aws_vpc_security_group_egress_rule" "eice_svc_b_ssh" {
  security_group_id = aws_security_group.eice_svc_b.id
  cidr_ipv4         = local.svc_b_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "svc_b" {
  subnet_id          = aws_subnet.svc_b[0].id
  security_group_ids = [aws_security_group.eice_svc_b.id]
  preserve_client_ip = false
  tags               = { Name = "eice-svc-b" }
}
```

**`labs/ans-30-vpc-lattice/terraform/iam.tf`**
```hcl
# iam.tf
#
# Plain English: lab 30's client role, lab-<id>-client, under the lab
# boundary, which vm-client runs as. Its one permission is to invoke VPC
# Lattice services in this account and Region (vpc-lattice-svcs:Invoke);
# the auth policies in lattice.tf then decide which services it may really
# call. The policy is known at plan (ruling A42), so it names the Region's
# services by pattern rather than by their ids, which exist only after
# apply.

resource "aws_iam_role" "client" {
  name                 = "lab-${var.lab_id}-client"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "invoke" {
  name = "lab-${var.lab_id}-invoke"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeLatticeServices"
      Effect   = "Allow"
      Action   = "vpc-lattice-svcs:Invoke"
      Resource = "arn:aws:vpc-lattice:${var.region}:${data.aws_caller_identity.current.account_id}:service/*"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "client" {
  role       = aws_iam_role.client.name
  policy_arn = aws_iam_policy.invoke.arn
}

resource "aws_iam_instance_profile" "client" {
  name = "lab-${var.lab_id}-client"
  path = "/cloudlabs-lab/"
  role = aws_iam_role.client.name
}
```

**`labs/ans-30-vpc-lattice/terraform/lattice.tf`**
```hcl
# lattice.tf
#
# Plain English: lab 30's VPC Lattice (ruling P19). One service network,
# lab-<id>-sn, that requires signed requests (AWS_IAM), and two HTTP
# services on it: svc-a, whose target is vm-svc-a in vpc-lab, and svc-b,
# whose target is vm-svc-b in vpc-svc-b. Each service has a listener on port
# 80 forwarding to a target group of one instance, health-checked on "/".
# vpc-lab is associated with the network through the security group
# sg-lattice (HTTP in from vpc-lab), so its instances can call both services;
# vpc-svc-b is not associated: it only hosts a target.
#
# Who may call what: the network's auth policy lets only the lab's client
# role invoke anything on it; svc-a's lets that role make GET requests;
# svc-b has no auth policy, and a service that requires signing with no
# policy refuses everyone (a Thing to try). Both policies are known at plan
# and name the role by its ARN, built from the account and the role's own
# fixed path and name (rulings P7, P19). Targets are registered and policies
# put 20 seconds after their target groups, services and network are made
# (ruling P21: Lattice's tags are not yet proven to be readable at once).

locals {
  client_role_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cloudlabs-lab/lab-${var.lab_id}-client"
}

data "aws_ec2_managed_prefix_list" "lattice" {
  name = "com.amazonaws.${var.region}.vpc-lattice"
}

resource "aws_security_group" "lattice" {
  name        = "lab-lattice"
  description = "vpc-lab's association with the service network: HTTP from vpc-lab"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-lattice" }
}

resource "aws_vpc_security_group_ingress_rule" "lattice_http" {
  security_group_id = aws_security_group.lattice.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpclattice_service_network" "lab" {
  name      = "lab-${var.lab_id}-sn"
  auth_type = "AWS_IAM"
  tags      = { Name = "sn-lab" }
}

resource "aws_vpclattice_service" "a" {
  name      = "lab-${var.lab_id}-svc-a"
  auth_type = "AWS_IAM"
  tags      = { Name = "svc-a" }
}

resource "aws_vpclattice_service" "b" {
  name      = "lab-${var.lab_id}-svc-b"
  auth_type = "AWS_IAM"
  tags      = { Name = "svc-b" }
}

resource "aws_vpclattice_target_group" "a" {
  name = "lab-${var.lab_id}-tg-a"
  type = "INSTANCE"

  config {
    port           = 80
    protocol       = "HTTP"
    vpc_identifier = aws_vpc.lab.id

    health_check {
      enabled  = true
      protocol = "HTTP"
      port     = 80
      path     = "/"
    }
  }
  tags = { Name = "tg-a" }
}

resource "aws_vpclattice_target_group" "b" {
  name = "lab-${var.lab_id}-tg-b"
  type = "INSTANCE"

  config {
    port           = 80
    protocol       = "HTTP"
    vpc_identifier = aws_vpc.svc_b.id

    health_check {
      enabled  = true
      protocol = "HTTP"
      port     = 80
      path     = "/"
    }
  }
  tags = { Name = "tg-b" }
}

# Ruling P21: the first tag-checked change on each new Lattice item waits 20 seconds after its create.
resource "time_sleep" "lattice_tags" {
  create_duration = "20s"
  depends_on = [
    aws_vpclattice_service_network.lab,
    aws_vpclattice_service.a,
    aws_vpclattice_service.b,
    aws_vpclattice_target_group.a,
    aws_vpclattice_target_group.b,
  ]
}

resource "aws_vpclattice_target_group_attachment" "a" {
  target_group_identifier = aws_vpclattice_target_group.a.id

  target {
    id   = aws_instance.svc_a.id
    port = 80
  }
  depends_on = [time_sleep.lattice_tags]
}

resource "aws_vpclattice_target_group_attachment" "b" {
  target_group_identifier = aws_vpclattice_target_group.b.id

  target {
    id   = aws_instance.svc_b.id
    port = 80
  }
  depends_on = [time_sleep.lattice_tags]
}

resource "aws_vpclattice_listener" "a" {
  name               = "http-80"
  protocol           = "HTTP"
  port               = 80
  service_identifier = aws_vpclattice_service.a.id

  default_action {
    forward {
      target_groups {
        target_group_identifier = aws_vpclattice_target_group.a.id
        weight                  = 100
      }
    }
  }
  tags = { Name = "listener-a" }
}

resource "aws_vpclattice_listener" "b" {
  name               = "http-80"
  protocol           = "HTTP"
  port               = 80
  service_identifier = aws_vpclattice_service.b.id

  default_action {
    forward {
      target_groups {
        target_group_identifier = aws_vpclattice_target_group.b.id
        weight                  = 100
      }
    }
  }
  tags = { Name = "listener-b" }
}

resource "aws_vpclattice_service_network_service_association" "a" {
  service_identifier         = aws_vpclattice_service.a.id
  service_network_identifier = aws_vpclattice_service_network.lab.id
  tags                       = { Name = "sn-svc-a" }
}

resource "aws_vpclattice_service_network_service_association" "b" {
  service_identifier         = aws_vpclattice_service.b.id
  service_network_identifier = aws_vpclattice_service_network.lab.id
  tags                       = { Name = "sn-svc-b" }
}

resource "aws_vpclattice_service_network_vpc_association" "lab" {
  vpc_identifier             = aws_vpc.lab.id
  service_network_identifier = aws_vpclattice_service_network.lab.id
  security_group_ids         = [aws_security_group.lattice.id]
  tags                       = { Name = "sn-vpc-lab" }
}

resource "aws_vpclattice_auth_policy" "network" {
  resource_identifier = aws_vpclattice_service_network.lab.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LabClientOnly"
      Effect    = "Allow"
      Principal = { AWS = local.client_role_arn }
      Action    = "vpc-lattice-svcs:Invoke"
      Resource  = "*"
    }]
  })
  depends_on = [time_sleep.lattice_tags, aws_iam_role.client]
}

resource "aws_vpclattice_auth_policy" "svc_a" {
  resource_identifier = aws_vpclattice_service.a.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LabClientGetOnly"
      Effect    = "Allow"
      Principal = { AWS = local.client_role_arn }
      Action    = "vpc-lattice-svcs:Invoke"
      Resource  = "*"
      Condition = { StringEquals = { "vpc-lattice-svcs:RequestMethod" = "GET" } }
    }]
  })
  depends_on = [time_sleep.lattice_tags, aws_iam_role.client]
}
```

**`labs/ans-30-vpc-lattice/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 30's three instances (t4g.nano, Amazon Linux 2023),
# each serving a page naming itself (lab-web.service, python3 on port 80).
# vm-client, in vpc-lab with the template's sg-vms, runs as the client role
# and has lattice-curl: curl signed with the instance's role credentials
# (SigV4 for vpc-lattice-svcs, the payload unsigned, as Lattice requires).
# vm-svc-a (vpc-lab) and vm-svc-b (vpc-svc-b) are the services' targets: they
# admit HTTP only from VPC Lattice's own addresses (AWS's managed prefix
# list), SSH from their VPC's Instance Connect Endpoint, and, once peered,
# SSH and HTTP from the VPN server's VPC (ruling A45).

locals {
  pages = {
    client = "vm-client in vpc-lab, the Lattice client"
    svc_a  = "svc-a answered: vm-svc-a in vpc-lab"
    svc_b  = "svc-b answered: vm-svc-b in vpc-svc-b"
  }
  web_units = { for k, text in local.pages : k => join("\n", [
    "[Unit]",
    "Description=Lab 30 page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"${text}\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ]) }
  lattice_curl = join("\n", [
    "#!/bin/sh",
    "# lattice-curl <url> [curl options]: curl, signed (SigV4) as this instance's role, for VPC Lattice.",
    "T=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')",
    "md() { curl -s -H \"X-aws-ec2-metadata-token: $T\" http://169.254.169.254/latest/meta-data/$1; }",
    "ROLE=$(md iam/security-credentials/)",
    "CREDS=$(md iam/security-credentials/$ROLE)",
    "get() { printf '%s' \"$CREDS\" | python3 -c \"import json, sys; print(json.load(sys.stdin)['$1'])\"; }",
    "exec curl -sS --aws-sigv4 'aws:amz:${var.region}:vpc-lattice-svcs' --user \"$(get AccessKeyId):$(get SecretAccessKey)\" -H \"x-amz-security-token: $(get Token)\" -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' \"$@\"",
    "",
  ])
  web_cloud_init = { for k, unit in local.web_units : k => "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = concat(
      [{ path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = unit }],
      k == "client" ? [{ path = "/usr/local/bin/lattice-curl", permissions = "0755", content = local.lattice_curl }] : []
    )
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}" }
}

resource "aws_security_group" "targets_a" {
  name        = "lab-targets-a"
  description = "vm-svc-a: HTTP from VPC Lattice, SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-targets-a" }
}

resource "aws_vpc_security_group_ingress_rule" "targets_a_lattice" {
  security_group_id = aws_security_group.targets_a.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.lattice.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "targets_a_ssh_eice" {
  security_group_id            = aws_security_group.targets_a.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "targets_a_ssh_gateway" {
  security_group_id = aws_security_group.targets_a.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "targets_a_http_gateway" {
  security_group_id = aws_security_group.targets_a.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "targets_a_all" {
  security_group_id = aws_security_group.targets_a.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "targets_b" {
  name        = "lab-targets-b"
  description = "vm-svc-b: HTTP from VPC Lattice, SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.svc_b.id
  tags        = { Name = "sg-targets-b" }
}

resource "aws_vpc_security_group_ingress_rule" "targets_b_lattice" {
  security_group_id = aws_security_group.targets_b.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.lattice.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "targets_b_ssh_eice" {
  security_group_id            = aws_security_group.targets_b.id
  referenced_security_group_id = aws_security_group.eice_svc_b.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "targets_b_ssh_gateway" {
  security_group_id = aws_security_group.targets_b.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "targets_b_http_gateway" {
  security_group_id = aws_security_group.targets_b.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "targets_b_all" {
  security_group_id = aws_security_group.targets_b.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "client" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  iam_instance_profile   = aws_iam_instance_profile.client.name
  user_data              = local.web_cloud_init["client"]

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-client" })
  tags        = { Name = "vm-client" }
  depends_on  = [aws_iam_role_policy_attachment.client]
}

resource "aws_instance" "svc_a" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[1].id
  vpc_security_group_ids = [aws_security_group.targets_a.id]
  user_data              = local.web_cloud_init["svc_a"]

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-svc-a" })
  tags        = { Name = "vm-svc-a" }
}

resource "aws_instance" "svc_b" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.svc_b[0].id
  vpc_security_group_ids = [aws_security_group.targets_b.id]
  user_data              = local.web_cloud_init["svc_b"]

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-svc-b" })
  tags        = { Name = "vm-svc-b" }
  depends_on  = [aws_route_table_association.svc_b]
}
```

**`labs/ans-30-vpc-lattice/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 30 is up: the three
# instances, how to connect to vm-client and vm-svc-b, the two services'
# Lattice names (each answers only signed, allowed requests: lattice-curl on
# vm-client signs them), and, while peered, SSH and the page on vm-client.
# vpc-lab is the hub.

output "private_ips" {
  value = { "vm-client" = aws_instance.client.private_ip, "vm-svc-a" = aws_instance.svc_a.private_ip, "vm-svc-b" = aws_instance.svc_b.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.client.id} --os-user labadmin --connection-type eice",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.svc_b.id} --os-user labadmin --connection-type eice",
    "svc-a: http://${aws_vpclattice_service.a.dns_entry[0].domain_name}  (from vm-client: lattice-curl http://${aws_vpclattice_service.a.dns_entry[0].domain_name})",
    "svc-b: http://${aws_vpclattice_service.b.dns_entry[0].domain_name}  (from vm-client: lattice-curl http://${aws_vpclattice_service.b.dns_entry[0].domain_name})",
    "ssh labadmin@${aws_instance.client.private_ip}",
    "curl http://${aws_instance.client.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/ans-30-vpc-lattice/readme.md`** (exactly):
````markdown
VPC Lattice joins services across VPCs at the application layer: a client calls a service by name, and Lattice carries the request to the service's targets wherever they run, with no peering, no transit gateway and no routes between the VPCs. Who may call what is decided by IAM, in auth policies on the service network and on each service, against requests the client signs with its own credentials. Everything is listed in the lab's resource group, `lab-ans-30-vpc-lattice`, in AWS Resource Groups (London); the Lattice pieces are under VPC, VPC Lattice in the console.
From the ANS-C01 outline: design service-to-service connectivity across VPCs with VPC Lattice, and secure it with IAM auth policies and signed (SigV4) requests.

## What it deploys

- The service network `lab-ans-30-vpc-lattice-sn` (Name `sn-lab`), which requires every request to be signed (auth type AWS_IAM), associated with `vpc-lab` through the security group `sg-lattice`
- The service `svc-a` (`lab-ans-30-vpc-lattice-svc-a`): HTTP on port 80 to its target `vm-svc-a`, in `vpc-lab`
- The service `svc-b` (`lab-ans-30-vpc-lattice-svc-b`): HTTP on port 80 to its target `vm-svc-b`, in a second VPC, `vpc-svc-b` (the slot's second /20), which has no peering and no route to `vpc-lab`
- The client `vm-client` in `vpc-lab`, running as the role `lab-ans-30-vpc-lattice-client`, with `lattice-curl`, a small command that signs each request with that role
- Auth policies: the network lets only the client role invoke anything; `svc-a` lets it make GET requests; `svc-b` has none, so it refuses everyone
- The targets admit HTTP only from VPC Lattice's own addresses (AWS's managed prefix list `com.amazonaws.eu-west-2.vpc-lattice`)

```text
lab-ans-30-vpc-lattice (London)
  vm-client [role client] (vpc-lab) --signed GET--> sn-lab (auth: client role only) --> svc-a (auth: GET only) --> vm-svc-a (vpc-lab)
  vm-client --signed GET--> sn-lab --> svc-b (no auth policy: refused) --> vm-svc-b (vpc-svc-b)
  vpc-lab and vpc-svc-b: no peering, no routes; targets admit only Lattice's prefix list
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Connect to `vm-client` (the first Connect line) and call `svc-a` signed: `lattice-curl http://<svc-a name>` (the third line) answers "svc-a answered". `lattice-curl` is plain curl: it reads the role's credentials from the instance metadata and runs `curl --aws-sigv4 "aws:amz:eu-west-2:vpc-lattice-svcs" --user "<key id>:<secret>" -H "x-amz-security-token: <token>" -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" <url>`. Read it with `cat /usr/local/bin/lattice-curl`.
- Call `svc-a` without signing: `curl -i http://<svc-a name>` is refused with 403, because the network requires every request to be signed. Then `lattice-curl -i -X POST http://<svc-a name>`: signed by the right role, and still 403, because svc-a's policy allows GET only.
- Call `svc-b`: `lattice-curl -i http://<svc-b name>` is refused with 403: a service that requires signing and has no auth policy lets nobody in. In the VPC console, VPC Lattice, Services, `lab-ans-30-vpc-lattice-svc-b`, Access, add an auth policy (copy svc-a's from its Access tab and leave out the Condition), save, and call again: the page comes from `vm-svc-b`, in a VPC with no route to `vm-client`'s.
- Look at `vpc-svc-b`'s route table `rt-svc-b` in the VPC console: no route to `vpc-lab`. Then open the security group `sg-targets-b`: HTTP comes only from the prefix list `com.amazonaws.eu-west-2.vpc-lattice` (VPC, Managed prefix lists), the link-local range Lattice reaches targets from.
- Connect to `vm-svc-b` (the second Connect line) and run `sudo journalctl -u lab-web -f` while you call it again: the requests arrive from a 169.254.171.x address, Lattice's, never from vm-client's.

## Learn more

- [What is Amazon VPC Lattice?](https://docs.aws.amazon.com/vpc-lattice/latest/ug/what-is-vpc-lattice.html)
- [Service networks in VPC Lattice](https://docs.aws.amazon.com/vpc-lattice/latest/ug/service-networks.html)
- [Control access to VPC Lattice services using auth policies](https://docs.aws.amazon.com/vpc-lattice/latest/ug/auth-policies.html)
- [SIGv4 authenticated requests for Amazon VPC Lattice](https://docs.aws.amazon.com/vpc-lattice/latest/ug/sigv4-authenticated-requests.html)
- [Control traffic in VPC Lattice using security groups](https://docs.aws.amazon.com/vpc-lattice/latest/ug/security-groups.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-30-vpc-lattice` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-30-vpc-lattice.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Join two services in different VPCs with VPC Lattice and control who calls them with IAM auth policies.
learn:
  - Reach services in another VPC through a Lattice service network
  - Sign requests with an instance role and SigV4
  - Allow and refuse callers with network and service auth policies
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-ans-30-vpc-lattice · London`; `vnet vpc-lab` with `subnet snet-private-1/2`; `vnet vpc-svc-b` with `subnet snet-svc-b-1/2`; no edge between the two VPCs; `lattice sn-lab`, `lattice svc-a`, `lattice svc-b`; `dependency` edges `service` from `sn-lab` to `svc-a` and to `svc-b`; a `traffic` edge `associated` from `vpc-lab` to `sn-lab`; `traffic` edges `HTTP` from `svc-a` to `vm vm-svc-a` and from `svc-b` to `vm vm-svc-b`; `vm vm-client`; `managedIdentity lab-ans-30-vpc-lattice-client`; `routeTable rt-private`, `rt-svc-b`; `nsg sg-eice`, `sg-vms`, `sg-lattice`, `sg-targets-a`, `sg-eice-svc-b`, `sg-targets-b`; `bastion eice-lab`, `eice-svc-b`; `privateEndpoint vpce-s3`, `vpce-s3-svc-b`. The target groups, attachments, listeners, associations and auth policies fold into their parents (ruling P22); no card for `time_sleep`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-ans-30.test.mjs`:

```js
// labs-aws-ans-30.test.mjs
//
// Plain English: lab ans-30-vpc-lattice is the lab AWS labs spec §12.2 row 30
// describes: a Lattice service network requiring signed requests, two
// services with instance targets in two VPCs, IAM auth policies, and a
// client signing with SigV4 (rulings P7, P19, P21).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-30-vpc-lattice";
const block = (type, name) => awsLab(ID).blocks.find((b) => b.kind === "resource" && b.labels[0] === type && (name === undefined || b.labels[1] === name))?.body ?? "";

test("ans-30 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-30's lab.yaml: §12.2 row 30, after ans-24, about £0.05/h, one role", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.security"], ["ans-24-privatelink"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 6, destroy_min: 5, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.identity, { creates: ["role"], roles: [], governance: false });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.045 && total < 0.06, `about £0.05/h, got ${total}`);
  const s = yaml.cost.items.find((i) => i.name.startsWith("VPC Lattice services"));
  assert.deepEqual([s.gbp_h, s.qty, s.aws_price], [0.0188, 2, undefined]);
});

test("ans-30's Lattice (ruling P19): a signing-only network, two signing-only services, instance targets in two VPCs, only vpc-lab associated", () => {
  const { tf } = awsLab(ID);
  assert.equal([...tf.matchAll(/auth_type = "AWS_IAM"/g)].length, 3);
  assert.equal([...tf.matchAll(/type = "INSTANCE"/g)].length, 2);
  assert.match(block("aws_vpclattice_target_group", "a"), /vpc_identifier = aws_vpc\.lab\.id/);
  assert.match(block("aws_vpclattice_target_group", "b"), /vpc_identifier = aws_vpc\.svc_b\.id/);
  assert.match(block("aws_vpclattice_target_group_attachment", "a"), /id\s+= aws_instance\.svc_a\.id/);
  assert.match(block("aws_vpclattice_target_group_attachment", "b"), /id\s+= aws_instance\.svc_b\.id/);
  assert.match(block("aws_vpclattice_service_network_vpc_association", "lab"), /vpc_identifier\s+= aws_vpc\.lab\.id[\s\S]*security_group_ids\s+= \[aws_security_group\.lattice\.id\]/);
  assert.equal([...tf.matchAll(/resource "aws_vpclattice_service_network_vpc_association"/g)].length, 1);
  assert.match(tf, /svc_b_cidr = cidrsubnet\(var\.address_space, 2, 1\)/);
  assert.doesNotMatch(tf, /aws_vpc_peering_connection|resource "aws_route" /, "Lattice needs no peering and no routes");
});

test("ans-30's auth policies (rulings P7, P19): known at plan, the lab's client role only, GET only on svc-a, none on svc-b", () => {
  const { tf } = awsLab(ID);
  assert.match(tf, /client_role_arn = "arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:role\/cloudlabs-lab\/lab-\$\{var\.lab_id\}-client"/);
  assert.match(block("aws_vpclattice_auth_policy", "network"), /resource_identifier = aws_vpclattice_service_network\.lab\.arn[\s\S]*Principal = \{ AWS = local\.client_role_arn \}/);
  assert.match(block("aws_vpclattice_auth_policy", "svc_a"), /resource_identifier = aws_vpclattice_service\.a\.arn[\s\S]*"vpc-lattice-svcs:RequestMethod" = "GET"/);
  assert.equal([...tf.matchAll(/resource "aws_vpclattice_auth_policy"/g)].length, 2, "svc-b has no auth policy");
  assert.doesNotMatch(tf, /aws_iam_role\.client\.arn/, "the policies are known at plan");
  assert.match(block("aws_iam_policy", "invoke"), /Action\s+= "vpc-lattice-svcs:Invoke"/);
});

test("ans-30's waits and targets (rulings P21, A45): changes after 20 seconds; targets admit HTTP only from Lattice's prefix list", () => {
  const { tf } = awsLab(ID);
  assert.match(block("time_sleep", "lattice_tags"), /create_duration = "20s"/);
  for (const [t, n] of [["aws_vpclattice_target_group_attachment", "a"], ["aws_vpclattice_target_group_attachment", "b"], ["aws_vpclattice_auth_policy", "network"], ["aws_vpclattice_auth_policy", "svc_a"]]) assert.match(block(t, n), /depends_on\s+= \[time_sleep\.lattice_tags/, `${t}.${n}`);
  assert.match(tf, /name = "com\.amazonaws\.\$\{var\.region\}\.vpc-lattice"/);
  assert.equal([...tf.matchAll(/prefix_list_id\s+= data\.aws_ec2_managed_prefix_list\.lattice\.id/g)].length, 2);
});

test("ans-30's client signs with SigV4 for vpc-lattice-svcs, the payload unsigned", () => {
  const { files } = awsLab(ID);
  for (const s of ["--aws-sigv4 'aws:amz:${var.region}:vpc-lattice-svcs'", "x-amz-content-sha256: UNSIGNED-PAYLOAD", "x-amz-security-token", "/usr/local/bin/lattice-curl", "X-aws-ec2-metadata-token-ttl-seconds"]) assert.ok(files["compute.tf"].includes(s), s);
  assert.match(block("aws_instance", "client"), /iam_instance_profile\s+= aws_iam_instance_profile\.client\.name/);
});

test("ans-30's readme signs, is refused, and fixes svc-b by hand; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["lattice-curl", "--aws-sigv4", "403", "GET only", "no auth policy", "com.amazonaws.eu-west-2.vpc-lattice"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-ans-30.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; `variables.tf` is the template's header and its six blocks named under Files, verbatim (no `name_prefix`: every Lattice name is built from the lab id).

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/ans-30-vpc-lattice.mjs` (saa-15's form with `doc()`; `variables: c.variables`, as every AWS fixture: the pipeline passes every §4 variable, and a lab declares only those it uses). With `svcB = cidrsubnet(c.address, 2, 1)`, `role = \`arn:aws:iam::${ACCOUNT}:role/cloudlabs-lab/lab-ans-30-vpc-lattice-client\``, data: `awsData()` plus `{ address: "data.aws_ec2_managed_prefix_list.lattice", values: { name: "com.amazonaws.eu-west-2.vpc-lattice", id: "pl-0123456789abcdef0", entries: [] }, args: [], refs: { name: ["var.region"] } }` (an AWS-managed list's id read at plan: the scope check counts an id equal to one a data source read as AWS's own); resources after `...templateResources(c)`, in file order:
  - **svc-b-vpc.tf**: `aws_vpc.svc_b` (known `cidr_block: svcB`; refs `["local.svc_b_cidr"]`), `aws_subnet.svc_b[0]`/`[1]` (`count: 2`, `cidrsubnet(svcB, 4, i)`, `eu-west-2a`/`b`), `aws_route_table.svc_b`, `aws_route_table_association.svc_b[0]`/`[1]`, `aws_vpc_endpoint.svc_b_s3`, `aws_security_group.eice_svc_b` and its egress rule (known `cidr_ipv4: svcB`), `aws_ec2_instance_connect_endpoint.svc_b` (known `preserve_client_ip: false`, Name; unknown `subnet_id` → `aws_subnet.svc_b[0]`, `security_group_ids.0` → `aws_security_group.eice_svc_b`). The subnets: unknown `vpc_id` → `aws_vpc.svc_b`, refs `cidr_block: ["local.svc_b_cidr", "count.index"]`, `availability_zone: ["local.azs", "count.index"]`, `tags: ["count.index"]`; the associations: unknown `subnet_id` (refs `["aws_subnet.svc_b", "count.index"]`) and `route_table_id`; the route table: unknown `vpc_id`; the endpoint: known `service_name: "com.amazonaws.eu-west-2.s3"`, `vpc_endpoint_type: "Gateway"`, unknown `vpc_id`, `route_table_ids` (refs `service_name: ["var.region"]`); the group: known `name: "lab-eice-svc-b"` and description, unknown `vpc_id`; its rule: known `cidr_ipv4: svcB`, `ip_protocol: "tcp"`, ports 22, unknown `security_group_id`.
  - **iam.tf**: `aws_iam_role.client` (known name, path, `BOUNDARY`, ec2 trust); `aws_iam_policy.invoke` (known `policy: doc([{ Sid: "InvokeLatticeServices", Effect: "Allow", Action: "vpc-lattice-svcs:Invoke", Resource: \`arn:aws:vpc-lattice:eu-west-2:${ACCOUNT}:service/*\` }])`; refs `policy: ["var.region", ...ref("data.aws_caller_identity.current", "account_id")]`); the attachment; the instance profile.
  - **lattice.tf**: `aws_security_group.lattice` and its ingress rule (known `cidr_ipv4: c.vpcCidr`); `aws_vpclattice_service_network.lab` (known `name: "lab-ans-30-vpc-lattice-sn"`, `auth_type: "AWS_IAM"`, Name; refs `name: ["var.lab_id"]`); `aws_vpclattice_service.a` and `.b` (known `name` `…-svc-a`/`-svc-b`, `auth_type: "AWS_IAM"`, Name; `dns_entry` unknown, as the provider computes it); `aws_vpclattice_target_group.a` and `.b` (known `name` `…-tg-a`/`-tg-b`, `type: "INSTANCE"`, `config: [{ port: 80, protocol: "HTTP", health_check: [{ enabled: true, protocol: "HTTP", port: 80, path: "/" }] }]`; unknown `config.0.vpc_identifier` → `aws_vpc.lab` / `aws_vpc.svc_b`); `time_sleep.lattice_tags` (known `create_duration: "20s"`); `aws_vpclattice_target_group_attachment.a`/`.b` (known `target: [{ port: 80 }]`; unknown `target_group_identifier` → the group's `id`, `target.0.id` → `aws_instance.svc_a.id` / `.svc_b.id`); `aws_vpclattice_listener.a`/`.b` (known `name: "http-80"`, `protocol: "HTTP"`, `port: 80`, `default_action: [{ forward: [{ target_groups: [{ weight: 100 }] }] }]`, Name; unknown `service_identifier` → the service's `id`, `default_action.0.forward.0.target_groups.0.target_group_identifier` → the group's `id`); `aws_vpclattice_service_network_service_association.a`/`.b` (unknown `service_identifier`, `service_network_identifier` by reference); `aws_vpclattice_service_network_vpc_association.lab` (unknown `vpc_identifier` → `aws_vpc.lab`, `service_network_identifier`, `security_group_ids` → `aws_security_group.lattice`); `aws_vpclattice_auth_policy.network` (known `policy: doc([{ Sid: "LabClientOnly", Effect: "Allow", Principal: { AWS: role }, Action: "vpc-lattice-svcs:Invoke", Resource: "*" }])`; unknown `resource_identifier` → `aws_vpclattice_service_network.lab.arn`; refs `policy: ["local.client_role_arn"]`) and `.svc_a` (the same with `Sid: "LabClientGetOnly"` and `Condition: { StringEquals: { "vpc-lattice-svcs:RequestMethod": "GET" } }`; `resource_identifier` → `aws_vpclattice_service.a.arn`).
  - **compute.tf**: `aws_security_group.targets_a`/`.targets_b` and their rules (the Lattice rules known `prefix_list_id: "pl-0123456789abcdef0"`, refs `ref("data.aws_ec2_managed_prefix_list.lattice", "id")`; the EICE rules unknown `referenced_security_group_id` → `aws_security_group.eice` / `.eice_svc_b`; the gateway rules known `cidr_ipv4: GATEWAY_CIDR`, refs `["var.gateway_cidr"]`; the egress rules known `0.0.0.0/0`, `-1`; every `security_group_id` unknown by reference); `al2023Instance(c, { key: "client", name: "vm-client", type: "t4g.nano", profile: "aws_iam_instance_profile.client" })` (sgs default `aws_security_group.vms`), `al2023Instance(c, { key: "svc_a", name: "vm-svc-a", type: "t4g.nano", subnet: "aws_subnet.private[1]", sgs: ["aws_security_group.targets_a"] })`, `al2023Instance(c, { key: "svc_b", name: "vm-svc-b", type: "t4g.nano", subnet: "aws_subnet.svc_b[0]", sgs: ["aws_security_group.targets_b"] })`, each with `refs.user_data = ["local.web_cloud_init[\"<key>\"]", "local.web_cloud_init"]` (known at plan: built from known locals and `var.region`; sensitive).

  `node --test scripts/test/lab-plans.test.mjs` proves it passes the scope check (P19's by-reference rules, the auth policies read as resource policies under P7 and P10) and the shape checks.

- [ ] **Step 5: Generate the planned graph and the readme diagram** (`npm run labs-topology -- ans-30-vpc-lattice`, `npm run labs-diagrams -- ans-30-vpc-lattice`); read the graph against "The diagram" above (a difference is a Task 10 rule fixed test-first); add `GOLDEN["ans-30-vpc-lattice"]` and `"ans-30-vpc-lattice"` to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-30.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-30-vpc-lattice`, `npm run labs-topology -- --check ans-30-vpc-lattice`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/ans-30-vpc-lattice labs/_learning/ans-30-vpc-lattice.yaml shared/topology/planned/ans-30-vpc-lattice.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-30 VPC Lattice service network with IAM auth policies and SigV4 clients

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 22: Lab ans-31-client-vpn

Spec: §12.2 row 31 (implementation, security; expert; explore; £ 0.12; peering optional; 10/8; 2/3; no prerequisites; Client VPN endpoint with mutual certificate auth (CA, server and client from `tls`, imported to ACM), split tunnel, authorisation rules, a target instance) and "Not built here" (Verified Access); §4 (`files` output); §7.4 (Client VPN public by nature); rulings A13, A45, P1, P2, P4, P8, P20, P25. Design sheet: Lab 31.

**Files:**
- Create: `labs/ans-31-client-vpn/lab.yaml`, `readme.md`
- Create: `labs/ans-31-client-vpn/terraform/versions.tf`, `main.tf`, `network.tf` (all three copied unchanged from `labs/_template-aws/`), `variables.tf` (the template's header and its `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password` and `tags` blocks, verbatim), `certs.tf`, `cvpn.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/ans-31-client-vpn.yaml`, `scripts/test/fixtures/labs/plans/labs/ans-31-client-vpn.mjs`
- Create (generated): `shared/topology/planned/ans-31-client-vpn.json`, `shared/guides/ans-31-client-vpn/**`
- Modify: `shared/guides/{index,placement}.json` (generated), `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-ans-31.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`AWS_FILES_LABS = ["ans-31-client-vpn"]`); Task 2 (`ec2:CreateClientVpnEndpoint` tagged, `AssociateClientVpnTargetNetwork` and `AuthorizeClientVpnIngress` as changes, `acm:ImportCertificate` with its tags in the call (V), `clientvpn` made ahead); Task 3 (the Client VPN and `tls` types on `AWS_TYPES`; lint rule `outputs`: a `files` output only here, `sensitive = true`); Task 4 (`batch4Problems`: the client CIDR inside the slot, certificate authentication only, split tunnel, no connection logs, no self-service portal, the server certificate and `authentication_options.0.root_certificate_chain_arn` the lab's own ACM import by reference (read at their own paths, `refsOf`), its security groups the lab's own; one target network association; the authorisation rule's CIDR inside the slot; the ACM import's key and certificate the lab's own `tls` resources); Task 6 (`del_cvpn`: target networks, then the endpoint; `del_cert` waits for the certificate to be free; the ready check's ACM `ISSUED` case); Task 7 (step 16 sends `files` beside the result; the Worker stores them and returns them only from `GET /labs/:id/secret`); Task 9 (Show lists each file with a Download button); Task 10 (`clientVpn` card in `vpc-lab`, `generic` certificate card, the `tls` resources ignored).

**`labs/ans-31-client-vpn/lab.yaml`**
```yaml
# Lab ans-31 (AWS labs batch 4). ANS-C01 ((V) the wording against the current
# exam guide): Network Implementation (remote access with AWS Client VPN);
# Network Security, Compliance, and Governance (mutual certificate
# authentication, authorisation rules, split tunnel).
# London list prices × 0.75 (labs-verify --aws-prices). Client VPN bills each
# target network association by the hour ($0.10, believed by the started
# hour, V) and each connection by the hour while a client is connected
# ($0.05, V); neither has a single regional hourly product the verifier can
# match, so both are authored. An imported ACM certificate is free.
id: ans-31-client-vpn
version: 1
cloud: aws
title: "AWS Client VPN with certificates, compared with WireGuard"
summary: >-
  An AWS Client VPN endpoint into the lab's VPC with mutual certificate authentication (a CA, a server and a client
  certificate made by Terraform and imported to ACM), split tunnel and an authorisation rule, and a ready-made OpenVPN
  profile to download, so you can connect from your PC and compare it with cloudlabs' own WireGuard server.
exam: ANS-C01
skill_areas: [ans.implementation, ans.security]
level: expert
type: explore
prerequisites: []
cost:
  items:
    - { name: "Client VPN subnet association ($0.10 an hour)", gbp_h: 0.0750, whole_hours: true }
    - { name: "Client VPN connection while you are connected ($0.05 an hour)", gbp_h: 0.0375 }
    - name: "EC2 t4g.nano, Linux (vm-target)"
      gbp_h: 0.0035
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "ACM imported certificate", gbp_h: 0 }
    - { name: "EC2 Instance Connect Endpoint", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 10, destroy_min: 8, session_h: 2, max_h: 3 }
capacity: { instance_types: [t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 2 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/ans-31-client-vpn/terraform/certs.tf`**
```hcl
# certs.tf
#
# Plain English: lab 31's certificates, made by Terraform's tls provider
# (ruling P20): a private certificate authority, "cloudlabs ans-31 CA", and
# two certificates it signs, one for the VPN server and one for you, the
# client; all RSA 2048, valid for 48 hours (longer than any session). The
# keys live only in the lab's Terraform state in R2 and, for the client, in
# the files you download (ruling A13). The server certificate is imported to
# ACM with the CA as its chain; because both certificates come from the same
# CA, that one import also tells Client VPN which CA to trust for clients
# (AWS documents this). ACM is never asked to issue anything: a lab
# certificate is import-only (ruling P14).

resource "tls_private_key" "ca" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_private_key" "server" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_private_key" "client" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem       = tls_private_key.ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 48
  allowed_uses          = ["cert_signing", "crl_signing"]

  subject {
    common_name  = "cloudlabs ans-31 CA"
    organization = "cloudlabs"
  }
}

resource "tls_cert_request" "server" {
  private_key_pem = tls_private_key.server.private_key_pem
  dns_names       = ["server.${var.name_prefix}.internal"]

  subject {
    common_name  = "server.${var.name_prefix}.internal"
    organization = "cloudlabs"
  }
}

resource "tls_locally_signed_cert" "server" {
  cert_request_pem      = tls_cert_request.server.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = 48
  allowed_uses          = ["server_auth", "digital_signature", "key_encipherment"]
}

resource "tls_cert_request" "client" {
  private_key_pem = tls_private_key.client.private_key_pem

  subject {
    common_name  = "client.${var.name_prefix}.internal"
    organization = "cloudlabs"
  }
}

resource "tls_locally_signed_cert" "client" {
  cert_request_pem      = tls_cert_request.client.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = 48
  allowed_uses          = ["client_auth", "digital_signature"]
}

resource "aws_acm_certificate" "server" {
  private_key       = tls_private_key.server.private_key_pem
  certificate_body  = tls_locally_signed_cert.server.cert_pem
  certificate_chain = tls_self_signed_cert.ca.cert_pem
  tags              = { Name = "cert-cvpn-server" }
}
```

**`labs/ans-31-client-vpn/terraform/cvpn.tf`**
```hcl
# cvpn.tf
#
# Plain English: lab 31's Client VPN endpoint, cvpn-lab (ruling P20).
# Clients prove who they are with a certificate from the lab's CA (mutual
# authentication; directory and SAML sign-in are never built). They get an
# address from the client range, the last /22 of the slot (inside the slot,
# outside every lab VPC), over OpenVPN on UDP 443. Split tunnel: only the
# lab VPC's range goes through the VPN, everything else stays on your own
# connection. One target network association, snet-private-1 (each bills
# by the hour; associating also adds the route to the VPC's range), and one
# authorisation rule letting every connected client reach vpc-lab.
# Connection logging and the self-service portal are off (ruling P8: no log
# group outside the lab's naming). The endpoint's security group sg-cvpn
# lets the VPN's traffic out to vpc-lab only.

locals {
  client_cidr = cidrsubnet(var.address_space, 4, 15)
}

resource "aws_security_group" "cvpn" {
  name        = "lab-cvpn"
  description = "Client VPN endpoint: out to vpc-lab only"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-cvpn" }
}

resource "aws_vpc_security_group_egress_rule" "cvpn_to_lab" {
  security_group_id = aws_security_group.cvpn.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "-1"
}

resource "aws_ec2_client_vpn_endpoint" "lab" {
  description            = "lab-${var.lab_id}"
  server_certificate_arn = aws_acm_certificate.server.arn
  client_cidr_block      = local.client_cidr
  split_tunnel           = true
  transport_protocol     = "udp"
  vpn_port               = 443
  vpc_id                 = aws_vpc.lab.id
  security_group_ids     = [aws_security_group.cvpn.id]
  self_service_portal    = "disabled"
  session_timeout_hours  = 8

  authentication_options {
    type                       = "certificate-authentication"
    root_certificate_chain_arn = aws_acm_certificate.server.arn
  }
  connection_log_options {
    enabled = false
  }
  tags = { Name = "cvpn-lab" }
}

resource "aws_ec2_client_vpn_network_association" "lab" {
  client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.lab.id
  subnet_id              = aws_subnet.private[0].id
}

resource "aws_ec2_client_vpn_authorization_rule" "lab" {
  client_vpn_endpoint_id = aws_ec2_client_vpn_endpoint.lab.id
  target_network_cidr    = local.vpc_cidr
  authorize_all_groups   = true
  description            = "every connected client may reach vpc-lab"
}
```

**`labs/ans-31-client-vpn/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 31's target, vm-target (t4g.nano, Amazon Linux 2023,
# snet-private-1), serving a page naming itself (lab-web.service, python3 on
# port 80). It admits SSH, HTTP and ping from the Client VPN endpoint's
# security group (Client VPN hands your traffic on from its own addresses in
# snet-private-1), SSH from the Instance Connect Endpoint and, once peered,
# SSH and HTTP from the VPN server's VPC (ruling A45).

locals {
  target_unit = join("\n", [
    "[Unit]",
    "Description=Lab 31 page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"vm-target in vpc-lab, reached over AWS Client VPN\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  target_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.target_unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_security_group" "target" {
  name        = "lab-target"
  description = "vm-target: SSH, HTTP and ping over Client VPN, SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-target" }
}

resource "aws_vpc_security_group_ingress_rule" "target_ssh_cvpn" {
  security_group_id            = aws_security_group.target.id
  referenced_security_group_id = aws_security_group.cvpn.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "target_http_cvpn" {
  security_group_id            = aws_security_group.target.id
  referenced_security_group_id = aws_security_group.cvpn.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_ingress_rule" "target_ping_cvpn" {
  security_group_id            = aws_security_group.target.id
  referenced_security_group_id = aws_security_group.cvpn.id
  ip_protocol                  = "icmp"
  from_port                    = -1
  to_port                      = -1
}

resource "aws_vpc_security_group_ingress_rule" "target_ssh_eice" {
  security_group_id            = aws_security_group.target.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "target_ssh_gateway" {
  security_group_id = aws_security_group.target.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_ingress_rule" "target_http_gateway" {
  security_group_id = aws_security_group.target.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "target_all" {
  security_group_id = aws_security_group.target.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "target" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.target.id]
  user_data              = local.target_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-target" })
  tags        = { Name = "vm-target" }
  depends_on  = [aws_vpc_endpoint.s3]
}
```

**`labs/ans-31-client-vpn/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 31 is up: vm-target's
# address, how to reach it (the Instance Connect Endpoint, over Client VPN,
# and, while peered, over WireGuard), and the files (ruling P2): an OpenVPN
# profile, ans-31.ovpn, holding the endpoint's name, the CA, your client
# certificate and its key inline, plus the certificate and key on their own.
# The files output is sensitive: Terraform never prints it, the pipeline
# sends it beside the run's result, and the dashboard hands it out only under
# Show while the session runs (ruling A13). remote-random-hostname puts a
# random label in front of the endpoint's name, as AWS's own profiles do.

locals {
  ovpn = join("\n", [
    "client",
    "dev tun",
    "proto udp",
    "remote ${replace(aws_ec2_client_vpn_endpoint.lab.dns_name, "*.", "")} 443",
    "remote-random-hostname",
    "resolv-retry infinite",
    "nobind",
    "remote-cert-tls server",
    "cipher AES-256-GCM",
    "verb 3",
    "<ca>",
    trimspace(tls_self_signed_cert.ca.cert_pem),
    "</ca>",
    "<cert>",
    trimspace(tls_locally_signed_cert.client.cert_pem),
    "</cert>",
    "<key>",
    trimspace(tls_private_key.client.private_key_pem),
    "</key>",
    "",
  ])
}

output "private_ips" {
  value = { "vm-target" = aws_instance.target.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.target.id} --os-user labadmin --connection-type eice",
    "Download ans-31.ovpn under Show, import it into the AWS VPN Client or OpenVPN, then: ssh labadmin@${aws_instance.target.private_ip}, curl http://${aws_instance.target.private_ip}",
    "ssh labadmin@${aws_instance.target.private_ip}",
    "curl http://${aws_instance.target.private_ip}",
  ]
}

output "files" {
  sensitive = true
  value = {
    "ans-31.ovpn" = local.ovpn
    "client.crt"  = tls_locally_signed_cert.client.cert_pem
    "client.key"  = tls_private_key.client.private_key_pem
  }
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/ans-31-client-vpn/readme.md`** (exactly):
````markdown
AWS Client VPN is AWS's managed remote-access VPN: you run an OpenVPN-based client on your PC, prove who you are, and reach a VPC as if you were inside it. This lab builds one with mutual certificate authentication, the kind with no directory behind it: a certificate authority made by Terraform signs one certificate for the VPN and one for you, and the dashboard hands you a ready-made profile to download. cloudlabs reaches its labs through its own WireGuard server, so this is also a side-by-side comparison of the two. Everything is listed in the lab's resource group, `lab-ans-31-client-vpn`, in AWS Resource Groups (London); the endpoint is under VPC, Client VPN endpoints in the console.
From the ANS-C01 outline: implement remote access to VPCs with AWS Client VPN, with certificate authentication, authorisation rules and split tunnel.

## What it deploys

- The Client VPN endpoint `cvpn-lab` (description `lab-ans-31-client-vpn`): OpenVPN on UDP 443, mutual certificate authentication, split tunnel, clients given addresses from the last /22 of the lab's slot, sessions of at most 8 hours, connection logging off
- One target network association, `snet-private-1` in `vpc-lab` (it adds the route to `vpc-lab`'s range), and one authorisation rule letting every connected client reach `vpc-lab`
- The certificates: a CA ("cloudlabs ans-31 CA"), a server certificate imported to ACM as `cert-cvpn-server` (with the CA as its chain, so Client VPN trusts client certificates from the same CA), and your client certificate, all valid for 48 hours
- `vm-target` (t4g.nano, a page naming itself), which admits SSH, HTTP and ping from the VPN
- Under **Show**, three files to download: `ans-31.ovpn` (a complete profile with the CA, your certificate and key inside), `client.crt` and `client.key`

The endpoint takes about 10 minutes to become available: associating the subnet is the slow part.

```text
lab-ans-31-client-vpn (London)
  your PC (AWS VPN Client or OpenVPN, ans-31.ovpn) --UDP 443, certificates--> cvpn-lab --> snet-private-1 --> vm-target (vpc-lab)
  split tunnel: only vpc-lab's range goes through the VPN; the rest of your traffic stays on your own connection
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Connect: under **Show**, download `ans-31.ovpn`, import it into the AWS VPN Client (or OpenVPN GUI) and connect. Run the lab unpeered, or disconnect WireGuard first, so only one VPN carries the lab's range. Then `ssh labadmin@<vm-target>` (the session password) and open `http://<vm-target>` in your browser.
- Split tunnel: while connected, run `route print` (Windows) or `ip route` (Linux): only `vpc-lab`'s range points at the VPN; your internet traffic does not. WireGuard does the same with the server's `AllowedIPs` list in your profile.
- Who vm-target sees: on `vm-target` run `ss -tn state established '( sport = :22 )'`. Your SSH session comes from an address in `snet-private-1`, the endpoint's own interface, not from your client address in the /22: Client VPN hands your traffic on from its own addresses, which is why `sg-target` admits `sg-cvpn` rather than the client range.
- In the VPC console, Client VPN endpoints, `cvpn-lab`: the Connections tab shows your connection (each one bills by the hour). Revoke the authorisation rule (Authorization rules tab) and watch SSH stop while you stay connected; authorise `vpc-lab`'s range again for all users to put it back.
- Look at your certificate: `openssl x509 -in client.crt -noout -subject -issuer -dates -ext extendedKeyUsage`. It is signed by the lab's CA, valid for 48 hours, for client authentication only. Compare: WireGuard has no certificates or CA, only a key pair per peer that the server lists by its public key, and it bills nothing per connection; Client VPN bills per association-hour and per connection-hour, but needs no server of your own.

## Not built here

- **AWS Verified Access**: access to applications (not networks) without a VPN, each request checked against identity and device trust. It needs an identity provider or a device-trust provider this lab does not have.

## Learn more

- [What is AWS Client VPN?](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/what-is.html)
- [Mutual authentication in AWS Client VPN](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/mutual.html)
- [Split-tunnel on AWS Client VPN endpoints](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/split-tunnel-vpn.html)
- [AWS Client VPN authorization rules](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/cvpn-working-rules.html)
- [Import certificates into AWS Certificate Manager](https://docs.aws.amazon.com/acm/latest/userguide/import-certificate.html)
- [What is AWS Verified Access?](https://docs.aws.amazon.com/verified-access/latest/ug/what-is-verified-access.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-31-client-vpn` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/ans-31-client-vpn.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Connect your PC to a VPC through AWS Client VPN with certificates, and compare it with WireGuard.
learn:
  - Authenticate VPN clients with certificates from your own CA
  - Send only the VPC's range through the VPN with split tunnel
  - Grant and revoke access with Client VPN authorisation rules
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-ans-31-client-vpn · London`; `vnet vpc-lab` with `subnet snet-private-1/2`; `clientVpn cvpn-lab` in `vpc-lab` (the association and the authorisation rule fold into it); `generic cert-cvpn-server`; `vm vm-target`; `routeTable rt-private`; `nsg sg-eice`, `sg-vms`, `sg-cvpn`, `sg-target`; `bastion eice-lab`; `privateEndpoint vpce-s3`. No card for any `tls_*` resource.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-ans-31.test.mjs`:

```js
// labs-aws-ans-31.test.mjs
//
// Plain English: lab ans-31-client-vpn is the lab AWS labs spec §12.2 row 31
// describes: a Client VPN endpoint with mutual certificate authentication
// (CA, server and client from tls, imported to ACM), split tunnel, an
// authorisation rule and a target instance, with the client's files handed
// out through the sensitive files output (rulings A13, P2, P20).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_FILES_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "ans-31-client-vpn";
const block = (type, name) => awsLab(ID).blocks.find((b) => b.kind === "resource" && b.labels[0] === type && (name === undefined || b.labels[1] === name))?.body ?? "";
const output = (name) => awsLab(ID).blocks.find((b) => b.kind === "output" && b.labels[0] === name)?.body ?? "";

test("ans-31 keeps the AWS lab contract and is the files lab (ruling P1)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.deepEqual(AWS_FILES_LABS, [ID]);
});

test("ans-31's lab.yaml: §12.2 row 31, no prerequisites, about £0.12/h with the association billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.implementation", "ans.security"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 10, destroy_min: 8, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.1 && total < 0.13, `about £0.12/h, got ${total}`);
  const a = yaml.cost.items.find((i) => i.name.startsWith("Client VPN subnet association"));
  assert.deepEqual([a.gbp_h, a.whole_hours, a.aws_price], [0.075, true, undefined]);
});

test("ans-31's certificates (ruling P20): an RSA 2048 CA signing a server and a client certificate for 48 hours; one ACM import, used as server and root chain", () => {
  const { tf } = awsLab(ID);
  assert.equal([...tf.matchAll(/rsa_bits\s+= 2048/g)].length, 3);
  assert.equal([...tf.matchAll(/validity_period_hours = 48/g)].length, 3);
  for (const re of [/is_ca_certificate\s+= true/, /common_name\s+= "cloudlabs ans-31 CA"/, /allowed_uses\s+= \["server_auth", "digital_signature", "key_encipherment"\]/, /allowed_uses\s+= \["client_auth", "digital_signature"\]/]) assert.match(tf, re);
  const acm = block("aws_acm_certificate", "server");
  for (const re of [/private_key\s+= tls_private_key\.server\.private_key_pem/, /certificate_body\s+= tls_locally_signed_cert\.server\.cert_pem/, /certificate_chain = tls_self_signed_cert\.ca\.cert_pem/]) assert.match(acm, re);
  assert.doesNotMatch(tf, /domain_name|certificate_authority_arn|validation_method/, "import only (ruling P14)");
  assert.equal([...tf.matchAll(/resource "aws_acm_certificate"/g)].length, 1);
});

test("ans-31's endpoint (ruling P20): certificates only, the client /22 in the slot, split tunnel, no logs or portal, one association, one rule to vpc-lab", () => {
  const { tf } = awsLab(ID);
  const e = block("aws_ec2_client_vpn_endpoint", "lab");
  for (const re of [/server_certificate_arn = aws_acm_certificate\.server\.arn/, /client_cidr_block\s+= local\.client_cidr/, /split_tunnel\s+= true/, /transport_protocol\s+= "udp"/, /vpn_port\s+= 443/, /self_service_portal\s+= "disabled"/, /type\s+= "certificate-authentication"/, /root_certificate_chain_arn = aws_acm_certificate\.server\.arn/, /connection_log_options \{\n\s+enabled = false/]) assert.match(e, re);
  assert.match(tf, /client_cidr = cidrsubnet\(var\.address_space, 4, 15\)/);
  assert.equal([...tf.matchAll(/resource "aws_ec2_client_vpn_network_association"/g)].length, 1);
  assert.match(block("aws_ec2_client_vpn_authorization_rule", "lab"), /target_network_cidr\s+= local\.vpc_cidr/);
  assert.doesNotMatch(tf, /directory-service-authentication|federated-authentication|aws_ec2_client_vpn_route|cloudwatch_log_group/);
});

test("ans-31's files output (rulings A13, P2): sensitive, three files, a complete OpenVPN profile", () => {
  const o = output("files");
  assert.match(o, /^\s*sensitive = true$/m);
  for (const k of ['"ans-31.ovpn" = local.ovpn', '"client.crt"  = tls_locally_signed_cert.client.cert_pem', '"client.key"  = tls_private_key.client.private_key_pem']) assert.ok(o.includes(k), k);
  const { files } = awsLab(ID);
  for (const s of ['"client"', '"dev tun"', '"proto udp"', '"remote ${replace(aws_ec2_client_vpn_endpoint.lab.dns_name, "*.", "")} 443"', '"remote-random-hostname"', '"remote-cert-tls server"', '"cipher AES-256-GCM"', '"<ca>"', '"<cert>"', '"<key>"', "trimspace(tls_private_key.client.private_key_pem)"]) assert.ok(files["outputs.tf"].includes(s), s);
  assert.doesNotMatch(output("connect") + output("private_ips"), /private_key|cert_pem/, "no key or certificate outside the files output");
});

test("ans-31's target admits SSH, HTTP and ping from the VPN's security group", () => {
  const { tf } = awsLab(ID);
  assert.equal([...tf.matchAll(/referenced_security_group_id = aws_security_group\.cvpn\.id/g)].length, 3);
  assert.match(block("aws_vpc_security_group_egress_rule", "cvpn_to_lab"), /cidr_ipv4\s+= local\.vpc_cidr/);
});

test("ans-31's readme connects, compares with WireGuard and names Verified Access as not built; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["ans-31.ovpn", "**Show**", "WireGuard", "AllowedIPs", "split tunnel", "## Not built here", "Verified Access"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-ans-31.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; `variables.tf` is the template's header and its seven blocks named under Files, verbatim. `node infra/ci/lab-lint.mjs --cloud aws labs/ans-31-client-vpn/terraform` exits 0 with no problem listed (Task 3's `outputs` check reads the lab id from the folder name and passes this lab's sensitive `files` output).

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/ans-31-client-vpn.mjs` (saa-15's form). With `clientCidr = cidrsubnet(c.address, 4, 15)` and the name prefix `a31k3x9q`, resources after `...templateResources(c)`, in file order:
  - **certs.tf**: `tls_private_key.ca`, `.server`, `.client` (known `algorithm: "RSA"`, `rsa_bits: 2048`; the PEMs, `id` and fingerprints computed and unknown, `private_key_pem` sensitive, all from `computed.json`'s regenerated tls schema, Task 3); `tls_self_signed_cert.ca` (known `is_ca_certificate: true`, `validity_period_hours: 48`, `allowed_uses: ["cert_signing", "crl_signing"]`, `subject: [{ common_name: "cloudlabs ans-31 CA", organization: "cloudlabs" }]`; unknown `private_key_pem` → `tls_private_key.ca.private_key_pem`); `tls_cert_request.server` (known `dns_names: ["server.a31k3x9q.internal"]`, `subject: [{ common_name: "server.a31k3x9q.internal", organization: "cloudlabs" }]`; refs `dns_names`/`subject.0.common_name: ["var.name_prefix"]`; unknown `private_key_pem` → the server key) and `tls_cert_request.client` (known `subject` with `client.a31k3x9q.internal`; unknown `private_key_pem` → the client key); `tls_locally_signed_cert.server` and `.client` (known `validity_period_hours: 48`, `allowed_uses`; unknown `cert_request_pem`, `ca_private_key_pem`, `ca_cert_pem` by reference); `aws_acm_certificate.server` (known Name tag; unknown and sensitive `private_key` → `tls_private_key.server.private_key_pem`; unknown `certificate_body` → `tls_locally_signed_cert.server.cert_pem`, `certificate_chain` → `tls_self_signed_cert.ca.cert_pem`; `domain_name`, `certificate_authority_arn` absent).
  - **cvpn.tf**: `aws_security_group.cvpn` (unknown `vpc_id` → `aws_vpc.lab`) and `aws_vpc_security_group_egress_rule.cvpn_to_lab` (known `cidr_ipv4: c.vpcCidr`, `ip_protocol: "-1"`; refs `["local.vpc_cidr"]`); `aws_ec2_client_vpn_endpoint.lab` (known `description: "lab-ans-31-client-vpn"`, `client_cidr_block: clientCidr`, `split_tunnel: true`, `transport_protocol: "udp"`, `vpn_port: 443`, `self_service_portal: "disabled"`, `session_timeout_hours: 8`, `authentication_options: [{ type: "certificate-authentication" }]`, `connection_log_options: [{ enabled: false }]`, Name; unknown `server_certificate_arn`, `authentication_options.0.root_certificate_chain_arn` → `aws_acm_certificate.server.arn`, `vpc_id` → `aws_vpc.lab`, `security_group_ids` → `aws_security_group.cvpn`; `dns_name` computed; refs `client_cidr_block: ["local.client_cidr"]`, `description: ["var.lab_id"]`); `aws_ec2_client_vpn_network_association.lab` (unknown `client_vpn_endpoint_id` → the endpoint's `id`, `subnet_id` → `aws_subnet.private[0]`); `aws_ec2_client_vpn_authorization_rule.lab` (known `target_network_cidr: c.vpcCidr`, `authorize_all_groups: true`, `description`; unknown `client_vpn_endpoint_id`; refs `target_network_cidr: ["local.vpc_cidr"]`).
  - **compute.tf**: `aws_security_group.target` and its seven rules (the three `cvpn` ones unknown `referenced_security_group_id` → `aws_security_group.cvpn`, the ICMP one known `ip_protocol: "icmp"`, `from_port: -1`, `to_port: -1`); `al2023Instance(c, { key: "target", name: "vm-target", type: "t4g.nano", sgs: ["aws_security_group.target"] })` with `refs.user_data = ["local.target_cloud_init"]`.

  The fixture has no outputs, as no AWS fixture does: the `files` output is held by the lint's `outputs` rule on the text (Task 3) and by Task 7's workflow test. `node --test scripts/test/lab-plans.test.mjs` proves the plan passes the scope check (P20's Client VPN cases, the ACM import from the lab's own `tls` resources) and the shape checks.

- [ ] **Step 5: Generate the planned graph and the readme diagram** (`npm run labs-topology -- ans-31-client-vpn`, `npm run labs-diagrams -- ans-31-client-vpn`); read the graph against "The diagram" above (a difference is a Task 10 rule fixed test-first); add `GOLDEN["ans-31-client-vpn"]` and `"ans-31-client-vpn"` to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-ans-31.test.mjs scripts/test/lab-plans.test.mjs scripts/test/lab-lint.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts worker/test/labs-aws-files.test.ts`, then `npm run labs-check`, `npm run labs-tf -- ans-31-client-vpn`, `npm run labs-topology -- --check ans-31-client-vpn`, `npm run labs-diagrams -- --check`
Expected: all PASS (`labs-tf`'s mock plan marks the `files` output sensitive and never prints it).

- [ ] **Step 7: Commit**

```bash
git add labs/ans-31-client-vpn labs/_learning/ans-31-client-vpn.yaml shared/topology/planned/ans-31-client-vpn.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab ans-31 AWS Client VPN with mutual certificate authentication and a downloadable profile

Claude-Session: https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3"
```

---


---

### Task 23: Full gate (vitest run explicitly), price and link checks, V answers, spec rulings, PR and whole-branch review (controller)

The controller runs this task itself: it needs the local AWS admin keys (read-only calls only here) and the PR. Spec: §11, §14, §17.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-aws-labs-design.md` (§17 gains "### Rulings from the batch 4 plan (A110 on)": P1–P26 as A110–A135, each "**Ann. Title.** sentence. Reason.", worded as the other rulings; §4's provider paragraph: "A third alias … lab 26 …" becomes "lab 26's WAF web ACL takes the per-resource `region = "us-east-1"` and its Global Accelerator the default provider, which signs it in us-west-2 (A118); no lab has a third provider block"; §6's contract line gains `AWS_FILES_LABS`, `AWS_GA_LABS`, `AWS_PEER_REGION_LABS` and labs 23 and 24 in `AWS_DNS_LABS` (A110); §7.1's service-linked list gains `ipam`, `clientvpn`, `route53resolver` (A113) and `DenyAccountAndBilling` gains the logs resource policy (A117); §7.4's list says Global Accelerator fronts two internet-facing NLBs without client IP preservation (A118); §12.2 row 20's key resources read "IPAM free tier with an Amazon-provided IPv6 pool (A114)" for "IPAM free tier with a pool from the slot (V)", and row 26's "Global Accelerator to Network Load Balancers in London and Ireland (A118)" for "Global Accelerator to instances in London and Ireland")
- Modify (only if a check below fails): the labs' `lab.yaml` cost items and readme links; `infra/aws-bootstrap/lab-abac.json`/`lab-policies.json` and the pin (Task 2); `scripts/test/fixtures/labs/plans/computed.json`/`schema-facts.json` (Task 3); lab 22's AMI parameter, lab 23's dnsmasq install, lab 25's build packages (Step 3)
- Create: the PR

- [ ] **Step 1: Generate what an implementer could not.** If Task 2 left the ABAC files ungenerated: `node scripts/aws-labs-abac.mjs && node scripts/aws-labs-abac.mjs --render && node scripts/aws-labs-abac.mjs --check`, pin the hash, `node --test scripts/test/aws-labs-iam.test.mjs` (PASS), commit `chore(aws labs): regenerate the ABAC lists and rendered policies for batch 4`. If Task 3 left the schema facts ungenerated, run Task 3 Step 3, then `node --test scripts/test/lab-scope-aws.test.mjs scripts/test/lab-plans.test.mjs`, and commit. Record the render's policy count (expected 11–16 of 20, A83).

- [ ] **Step 2: Prices and links on the real services** (local keys, read only):
Run: `npm run labs-verify -- --aws-prices ans-20-vpc-design ans-21-transit-gateway ans-22-s2s-vpn ans-23-hybrid-dns ans-24-privatelink ans-25-load-balancing ans-26-edge ans-27-network-firewall ans-28-flow-logs-fix ans-29-multi-region ans-30-vpc-lattice ans-31-client-vpn` and `npm run labs-verify -- --links` with the same ids
Expected: every `aws_price` matches exactly one product and each authored figure is within 25%; every link answers 200. The new (V) filters (design sheet): NLB (`Load Balancer-Network`), GWLB (`Load Balancer-Gateway`), GWLB endpoint (`{usage}-VpcEndpoint-GWLBE-Hours`), transit gateway attachment (`{usage}-TransitGateway-Hours`, London and Ireland), VPN connection (`{usage}-VPN-Usage-Hours:ipsec.1`), Resolver interface (`{usage}-ResolverNetworkInterface`), Network Firewall (`{usage}-Endpoint-Hour`): one matching 0 or several products takes the distinguishing attribute the error names, or becomes authored-only (`aws_price` removed, `gbp_h` kept). A figure more than 25% off is set to AWS's; a dead link is replaced by the page it moved to. The labs are new (version 1): no bump. Record each answer for the PR body.

- [ ] **Step 3: The (V) facts batch 4 relies on** (local keys, read only; WebFetch for AWS's public pages; each answer under "V answers" in the PR body):
  - `aws service-quotas get-service-quota --service-code iam --quota-code L-0DA4ABF3 --region us-east-1 --query Quota.Value`: 20 (A83). Transit gateways per account (`ec2`, by name "Transit gateways per account", eu-west-2 and eu-west-1): at least 2 each (labs 21, 27, 29; preflight read 5). Client VPN endpoints per region: at least 1 (preflight 5). EC2-VPC Elastic IPs: 10 in eu-west-2 (labs 22, 25 take 2 and 2 with NAT). Site-to-site VPN connections per region (`ec2`, "VPN connections per region"): read it (preflight could not find it by name); below 1 is a STOP-free quota request (pre-approved).
  - IPAM: WebFetch `https://aws.amazon.com/vpc/pricing/` (IPAM tab): the Free Tier covers "Amazon-provided contiguous IPv6 CIDR blocks" and private IPv4 needs the Advanced Tier (P5). If the Free Tier no longer covers the IPv6 pool: lab 20 becomes `tier = "advanced"` with the per-IP charge authored, rule `size` in Task 4 follows, and P5's text changes in the spec (no STOP: cents an hour). `aws ec2 describe-ipams --region eu-west-2`: none (IPAM's one-per-region default quota is free for lab 20).
  - `aws ssm get-parameter --region eu-west-2 --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id --query Parameter.Name`: answers (P11; else the newest Ubuntu LTS arm64 parameter under `/aws/service/canonical/` that answers, lab 22 fixed before merge).
  - `aws ec2 describe-instance-type-offerings --location-type availability-zone --filters Name=instance-type,Values=t4g.nano,t4g.micro,t4g.small --region eu-west-2` and `--region eu-west-1`: each in zones a and b.
  - None of these exist outside the labs (P3's exemption and the name rules reach nothing else): `aws ec2 describe-transit-gateways`, `describe-transit-gateway-attachments`, `describe-vpn-gateways`, `describe-customer-gateways`, `describe-client-vpn-endpoints`, `describe-vpc-endpoint-service-configurations`, `describe-traffic-mirror-targets`, `route53resolver list-resolver-endpoints`, `network-firewall list-firewalls`, `vpc-lattice list-service-networks`, `acm list-certificates` in eu-west-2 and eu-west-1; `globalaccelerator list-accelerators --region us-west-2`; `wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1`; `cloudfront list-functions`. Any found: note it in the PR; not a stop.
  - `aws ec2 describe-security-groups --filters Name=group-name,Values=GlobalAccelerator --region eu-west-2` and `eu-west-1`: none (the baseline P9's release-test check compares against).
  - `aws logs describe-resource-policies --region eu-west-2` and `eu-west-1`: record what exists (P8 denies the labs any change to them; nothing a lab needs).
  - `aws iam get-role --role-name AWSServiceRoleForIPAM`, `AWSServiceRoleForClientVPN`, `AWSServiceRoleForRoute53Resolver`, `AWSServiceRoleForVPCTransitGateway`, `AWSServiceRoleForNetworkFirewall`, `AWSServiceRoleForGlobalAccelerator`, `AWSServiceRoleForVpcLattice`: record which exist (Task 24's bootstrap makes the first three, P4).
  - WebFetch `https://aws.amazon.com/waf/pricing/`: whether a web ACL's monthly fee is prorated hourly. If it is not: lab 26's release test costs about £4.70 more (the batch would pass its £4 target, never the project's £15): note it for Task 24 Step 5's order (lab 26 last), not a stop.
  - WebFetch `https://aws.amazon.com/network-firewall/pricing/`: the NAT gateway waiver per firewall endpoint hour (lab 27's estimate keeps the NAT item either way).
  - Left to Task 24's release tests, each named there: the accepter sides' tags (P3); Global Accelerator signed in us-west-2 by the default provider and listed there; no `GlobalAccelerator` group or interface made (P9); ACM's import with tags; the same certificate as Client VPN server and root chain; IPAM's provision and deprovision times; dnsmasq in AL2023; the tunnel handler's build; Lattice, Resolver and Network Firewall tag waits (P21); Traffic Mirroring on `t4g` (by hand); WAF and Resolver billing (Cost Explorer next day).

- [ ] **Step 4: Copy the rulings into the spec**: append "### Rulings from the batch 4 plan (A110 on)" to §17 with A110–A135 (P1 → A110 … P26 → A135), and make the §4, §6, §7.1, §7.4 and §12.2 (rows 20 and 26) edits named above. Commit `docs(aws labs): batch 4 rulings A110-A135`.

- [ ] **Step 5: The full gate.** Local `npm test` stops at the four known Azure "Remove lab peerings" node-test failures before vitest starts (batch 3's CI caught two vitest failures the local gate never reached), so the vitest suites run on their own, and the clean-up and pipeline scripts run where jq is:
Run: `npm run typecheck && npm test`
Expected: PASS but for exactly the four known local Azure failures (named in the report; anything else red is fixed test-first).
Run: `npx vitest run`
Expected: PASS (every Worker, web and shared suite).
Run: `docker run --rm -v "$PWD":/w -w /w node:24-bookworm bash -c "apt-get update -qq && apt-get install -y -qq jq >/dev/null && node --test scripts/test/lab-aws-cleanup.test.mjs scripts/test/lab-aws-pipeline.test.mjs scripts/test/lab-aws-workflow.test.mjs"`
Expected: PASS (none skipped for want of jq or bash).
Run: `npm run build:web && npm run bundle-size && npm run labs-check -- --base origin/main && npm run labs-tf && npm run labs-topology -- --check && npm run labs-diagrams -- --check`
Expected: all PASS; `bundle-size` within its limit (Task 9 added no dependency). Fix anything red test-first and commit.

- [ ] **Step 6: Push and open the PR**
```bash
git push -u origin feat/aws-labs-batch4
gh pr create --base main --title "AWS labs batch 4: labs ans-20 to ans-31" --body "$(cat <<'EOF'
AWS hands-on labs, batch 4 (spec docs/superpowers/specs/2026-10-15-aws-labs-design.md §14 B4; plan docs/superpowers/plans/2026-10-16-aws-labs-batch4-plan.md).

- Labs ans-20 VPC design (dual stack, IPAM, prefix lists), ans-21 Transit Gateway, ans-22 site-to-site VPN with BGP, ans-23 hybrid DNS, ans-24 PrivateLink, ans-25 ALB/NLB/GWLB, ans-26 CloudFront, WAF and Global Accelerator (London, Ireland, us-east-1, us-west-2), ans-27 Network Firewall, ans-28 break-fix flow logs and mirroring, ans-29 inter-region TGW peering, ans-30 VPC Lattice, ans-31 Client VPN (all Untested until their release tests from main)
- IAM: peering accepts judged by the accepter VPC; CloudWatch Logs' account resource policy denied; IPAM, Client VPN and Resolver service-linked roles made ahead
- Scope and lint: batch 4's types and never list; every new reference held to the lab; IPv6 global ranges are the internet; service-principal Allows name their source; vended logs to the lab's bucket; files output only in lab 31
- Clean-up: Global Accelerator in us-west-2, WAF after CloudFront, functions by name, Resolver and Lattice in order, endpoint services before load balancers, Client VPN, Network Firewall, VPN, transit gateways, IPAM cascaded, certificates
- Worker: lab files (migration 0025), us-west-2 reads, WAF and Lattice ARNs, a four-region diagram in 16 calls; web: files under Show with Download; diagrams for batch 4's types

Rulings A110-A135 are in the spec's §17. V answers (from Steps 1-3):

https://claude.ai/code/session_015gb5NxMLyGpBsaVBFW1CK3
EOF
)"
gh pr checks --watch
```
Expected: CI green.

- [ ] **Step 7: Whole-branch review**: one fresh reviewer on the most capable model, with the spec, this plan and `git diff origin/main...feat/aws-labs-batch4`. Ask about: the Review Focus list; the regenerated ABAC lists' diff and the two exempt accepts (can the role now accept anything into a VPC that is not a lab's?); `batch4Problems` (can a plan point an attachment, route, tunnel, resolver rule, endpoint, accelerator, auth policy, mirror target or Client VPN piece outside the lab?); P7's source rule against every existing lab; the safety net's new handlers (order across four regions, the endpoint-service step before load balancers, nothing deleted by name that is not `lab-<id>-*`); the files path end to end (never in a log, a session row, `LAB_RESULT` or the web's state after Hide); each lab against its §12.2 row and the design sheet. Fix each finding test-first, re-run Step 5's gate, push, wait for CI green.

---

### Task 24: Ship: spend check, bootstrap preview then apply, merge, migrate and deploy, release tests 20–31, leftovers, record, recalibrate (controller)

The controller runs this task itself. Spec: §11 (release tests, spend), §13, §14 (A24), §15. Budget: batch 4 aims at **≤ £4** of AWS test spend; the whole AWS labs project may spend ≤ £15 (about £0.33 so far; a projected overrun is a STOP). A change needed in `wg-aws.yml`, `infra/aws/**` or the deploy role is a STOP.

**Files:**
- Modify (after the tests): `docs/labs/release-tests.md`, `scripts/test/fixtures/labs/plans/shapes/ans-*.json` (written by `lab-release-test.mjs`), the labs' plan fixtures where a recorded shape differs (and `realistic.mjs` where the provider prints a batch 4 type its own way), memories `aws-labs-autonomy.md` (or `aws-support.md`), `labs-feature.md`, `golive-versions.md`, `MEMORY.md` (one line each)

Expected test spend (London list, one pass, every hourly item billed one whole hour): ans-24 ≈ £0.03; ans-28 ≈ £0.03; ans-20 ≈ £0.04; ans-22 ≈ £0.05; ans-30 ≈ £0.05; ans-26 ≈ £0.08 (≈ £4.70 if WAF bills a whole month, Task 23 Step 3); ans-31 ≈ £0.08; ans-25 ≈ £0.15; ans-21 ≈ £0.16; ans-29 ≈ £0.16; ans-23 ≈ £0.38 (four Resolver interface-hours); ans-27 ≈ £0.47 (a firewall endpoint-hour). About **£1.70 likely** and **£3.40 with one retry each**; batch target **≤ £4**.

- [ ] **Step 1: Spend check.** `aws ce get-cost-and-usage --region us-east-1 --time-period Start=<first of month>,End=<today> --granularity MONTHLY --metrics UnblendedCost --group-by Type=TAG,Key=cloudlabs-lab`. If the AWS labs project's test spend so far plus £4 would pass £15, STOP and report.

- [ ] **Step 2: Preview the bootstrap, then apply it** (local admin keys, from the PR branch: the role's new policies and service-linked roles must exist before the tests).
Run: the Terraform-plan-only preview batch 3 used (`bootstrap-preview.mjs`, path in batch 3's plan Task 17 Step 2; if that scratch file is gone, recreate it as a script that runs `terraform -chdir=infra/aws-bootstrap plan` with the local admin keys and never applies)
Expected: the `wg-admin-labs-N` policies holding the change list and `DenyAccountAndBilling` changed in place (the count unchanged or one more, at most 16), **no** change to the boundary, `wg-admin-deploy` or the Worker user, 0 destroy. Anything else: STOP and read it.
Run: `node scripts/aws-bootstrap.mjs --labs`
Expected: applied; all 69 role and 16 boundary simulator cases print as wanted; "Service-linked roles made ahead: ipam.amazonaws.com, clientvpn.amazonaws.com, route53resolver.amazonaws.com" (any already there left; any AWS will not make ahead reported, A57); the quotas met; the cost tag active. A simulator mismatch is fixed in `scripts/lib/aws-lab-policies.mjs` test-first, re-rendered, pushed, and the bootstrap run again.

- [ ] **Step 3: Merge, migrate and deploy.**
```bash
gh pr merge <PR number> --merge
git switch main && git pull
npm run deploy-worker
git checkout -- worker/src/build.ts
npx wrangler d1 execute wg-admin --remote --command "SELECT name FROM pragma_table_info('lab_runs') WHERE name = 'files_json'"
```
Expected: `deploy-worker` applies migration `0025_lab_files.sql`, then deploys; the query returns one row `files_json`; the new Worker version id. Write it, with the previous version as the rollback target, into memory `golive-versions.md` (a rollback leaves the column: it is nullable and unread by the old version).

- [ ] **Step 4: Dashboard checks** (Steven's signed-in Chrome; if not available, note "needs Steven's sign-in" and go on): the Labs tab shows thirty-one AWS cards, ans-20..31 "Untested v1"; ans-26's modal says "Runs unconnected" for peering (off) and names Ireland as its second region; ans-29's names Ireland; ans-21 names ans-20, ans-27 names ans-21, ans-30 names ans-24 as "run before"; the coverage map's ANS-C01 rows each show at least two labs.

- [ ] **Step 5: Release tests from main**, cheapest first, in three streams as batch 3 did (each always tears down; `--ref` defaults to main):
```bash
# stream A
node scripts/lab-release-test.mjs ans-24-privatelink --confirm-cost
node scripts/lab-release-test.mjs ans-22-s2s-vpn --confirm-cost
node scripts/lab-release-test.mjs ans-31-client-vpn --confirm-cost
node scripts/lab-release-test.mjs ans-29-multi-region --confirm-cost
# stream B
node scripts/lab-release-test.mjs ans-28-flow-logs-fix --confirm-cost
node scripts/lab-release-test.mjs ans-30-vpc-lattice --confirm-cost
node scripts/lab-release-test.mjs ans-25-load-balancing --confirm-cost
node scripts/lab-release-test.mjs ans-23-hybrid-dns --confirm-cost
# stream C
node scripts/lab-release-test.mjs ans-20-vpc-design --confirm-cost
node scripts/lab-release-test.mjs ans-21-transit-gateway --confirm-cost
node scripts/lab-release-test.mjs ans-27-network-firewall --confirm-cost
node scripts/lab-release-test.mjs ans-26-edge --confirm-cost
```
(Labs 21, 27 and 29 each make a transit gateway: three streams hold at most two at once, within the quota. Lab 26 runs last in its stream so a WAF surprise in the next day's Cost Explorer cannot multiply.)
Expected: each row in `docs/labs/release-tests.md` reads pass, clean yes, and saves its plan shape. After each: `aws resourcegroupstaggingapi get-resources --tag-filters Key=cloudlabs-lab,Values=<id> --region eu-west-2` (and `eu-west-1` for 26 and 29, `us-east-1` for 23, 24 and 26, `us-west-2` for 26) lists nothing that is not terminated, deleted or deleting; `aws iam list-roles --path-prefix /cloudlabs-lab/` lists none. The V answers each test gives, recorded in the batch report:
  - ans-24: the endpoint service made with the account root only; the interface endpoint connected without acceptance; the private zone listed in us-east-1 and judged gone; the safety net's endpoint-service step not needed (the destroy took them in order).
  - ans-22: the VPN connection `available` within 12 minutes; the router's EIP and its UDP 500/4500 rules; afterwards (by hand, while a later session runs, never for the verdict) `sudo swanctl --list-sas` shows two tunnels.
  - ans-31: ACM's import passed `CreateNeedsLabTag` (tags in the import call); Client VPN accepted the one certificate as server and root chain; the endpoint left `pending-associate`; `GET /labs/ans-31-client-vpn/secret` during the ready check (Chrome, Show) returned three files and the Download buttons saved them; after the test, `SELECT COUNT(*) FROM lab_runs WHERE files_json IS NOT NULL` is 0 (`npx wrangler d1 execute wg-admin --remote --command …`).
  - ans-29: both accepts passed with no `AccessDenied` (P3: record whether the accepter sides carried the requester's tags); the static routes after acceptance; deploy inside 15 minutes; Verify clean judged both regions' attachments `deleted`.
  - ans-28: the NLB healthy (health checks from its own subnet pass the faulty group and ACL); the S3 flow log's first objects under `AWSLogs/` with hive partitions; the Glue table and workgroup made; both mirror filter rules created though untagged (P17's exemption); the default ACL back on `snet-svc` after destroy (A82's pattern).
  - ans-30: `RegisterTargets` and `PutAuthPolicy` after the 20-second wait (P21); both associations `ACTIVE`; the services' and associations' deletes waited for; by hand on `vm-client` while the session runs (never the verdict), `lattice-curl http://<svc-a name>` answers (curl's `--aws-sigv4` with `x-amz-content-sha256: UNSIGNED-PAYLOAD` accepted, P19) and `svc-b` refuses with 403; if Lattice refuses the unsigned-payload header, the fix is `lattice-curl` without it (curl then signs the empty body), lab 30 version 2.
  - ans-25: the three load balancers `active`; ACM's import; the GWLB endpoint `available`; the appliance's build time from its console output (`aws ec2 get-console-output`), recorded against `deploy_min` 10; the endpoint service went before the GWLB.
  - ans-23: both endpoints `OPERATIONAL` at their fixed addresses (the design sheet's known risk not met, or its fallback taken); the rule association, firewall rule and query-log association after the wait (P21); the private zone in us-east-1; `aws ec2 describe-network-interfaces --filters Name=vpc-id,Values=<vpc-lab>` empty after destroy (the endpoints' interfaces gone before the VPC).
  - ans-20: IPAM, the IPv6 pool's `/52` provisioned and deprovisioned (the times, against 5/5); the IPv6 association; the IPAM `delete-complete` or gone.
  - ans-21: the three attachments and the blackhole route; appliance mode on the egress attachment; deploy and destroy inside 8/8.
  - ans-27: the firewall `READY` within 15 minutes and gone within 15 at destroy; the logging configuration after the wait (P21); alert objects in `cloudlabs-<prefix>-nfwlogs` if any traffic was dropped.
  - ans-26: Global Accelerator's calls signed in us-west-2 by the default provider (P9; a `UnrecognizedClientException` or region refusal here takes the fallback: a provider alias `region = "us-west-2"`, version 2); the accelerator listed by the tagging API in us-west-2 and judged gone by Verify clean; `aws ec2 describe-security-groups --filters Name=group-name,Values=GlobalAccelerator` empty in both regions during and after the test; the WAF ACL in us-east-1 deleted after CloudFront; the function deleted by name; deploy within 12 and destroy within 15 minutes.
  A failure: read the run's log, fix test-first on `fix/aws-labs-b4-<id>` (the lab's version rises if its folder changes; engine fixes need no bump), PR, CI green, merge, `npm run deploy-worker`, the bootstrap again if IAM changed, test again (A24). Pre-planned fixes: an `AccessDenied` on a change right after a create in Lattice, Resolver or Network Firewall (P21) adds that service to `TAG_LAG_NAMED` with its `lab-*` name pattern (test-first in `aws-labs-iam.test.mjs`, `--render`, bootstrap); an `AccessDenied` on `ec2:CreateTransitGatewayRoute` in Ireland through the accepter side's untagged attachment adds `ec2:CreateTransitGatewayRoute` to `CHANGE_TAG_EXEMPT` with a fixed deny requiring the lab tag on the route table (the same way); a `CreateServiceLinkedRole` refusal for a service not in `SERVICE_LINKED` adds it (V name from the error) and re-runs the bootstrap; ACM's import refused without tags (the provider tags after import) adds `acm:ImportCertificate` to `CREATE_TAG_EXEMPT` with the scope check already holding the certificate to the lab's own `tls` resources; a lab 23 deploy refused because a Resolver endpoint's fixed address is in use (the template's `eice-lab` took it) takes the design sheet's fallback, AWS-chosen endpoint addresses, version 2; lab 25's appliance not built in time is no failure (the ready check does not wait for it), its readme notes the minutes; a `GlobalAccelerator` security group found in a lab VPC is a STOP-free redesign (lab 26 version 2) never a weaker guard. Anything that would touch the VPN server is a STOP. Record each deploy and destroy time and raise `deploy_min`/`destroy_min` (with a version bump) where the real time is longer.

- [ ] **Step 6: Leftovers and orphans, two hours on.** At least 90 minutes after the last test, after the Worker's next hourly AWS sweep, the Labs tab's leftovers list (KV `labs:orphans`) has no AWS entry. A transit gateway, VPN item, IPAM or Lattice item, Global Accelerator in us-west-2 or a WAF ACL in us-east-1 there means the tagging API keeps it past the grace: fix test-first in `worker/src/labs/orphans.ts` (skip that type once EC2 or its service confirms it deleted, as A108 does for instances) and deploy.

- [ ] **Step 7: Mark the versions released.** For each lab whose script test passed, press **Test** in Settings → Labs (Chrome) so `lab_release_tests` records it and the cards drop "Untested"; or, without the dashboard, note that the cards stay "Untested" until Steven presses Test.

- [ ] **Step 8: Record, recalibrate and clean up.** On `chore/aws-labs-b4-release`: commit `docs/labs/release-tests.md` and the shapes; make each lab's plan fixture match its recorded shape (`node --test scripts/test/lab-plans.test.mjs` names every difference; lab 27's firewall-endpoint route references are a drafted guess, Task 18 Step 4; where the aws provider prints a batch 4 type in a way every fixture should follow, put it in `realistic.mjs` with a test); PR, merge when green. The next day, read Cost Explorer for the test day by service (WAF, Route 53 Resolver, Network Firewall, Global Accelerator, VPC Lattice, Client VPN) and record each against the estimate. Record the month's AWS spend before and after. Update memories: the AWS labs memory (B4 live: all 31 labs, Worker version, V answers, spend), `labs-feature.md` (AWS labs 20–31 released or not, with spend), `golive-versions.md`, and `MEMORY.md`'s index lines.

---

## Carried forward

Batches 1–3's deferred items (batch 3's "Carried forward" table, its whole-branch review's unfixed minors in PR #144's body, and the preflight list) and what batch 4 does with each:

| Item | Batch 4 |
|---|---|
| Batch 1 Task 2 / final Minor 4: IPv6 "internet" only at `/0` | **Done** (P6, Task 3), before lab 20 |
| Batch 2 Task 3 M-6: SourceAccount/SourceArn on service-principal Allows | **Done** for every resource policy and Lattice auth policy (P7, Task 3) |
| Batch 2 final review M-4: a failed CloudFront disable is not retried | **Done** (P10, Task 5) |
| Ruling: Unblock's Lambda ENI wait moves into the safety net | Carried: no batch 4 lab runs a Lambda in a VPC (P26); it moves when one does |
| Spec §6: lab 18 also reads the Standard Spot quota `L-34B43A08` | Carried: the AWS feeds' worst case is still 28 calls against a run budget of 25, and lab 18's warning over-counts on the On-Demand quota meanwhile (A91); worth a feed-budget redesign of its own, not a batch's side task |
| AWS sprite icons for API Gateway, Cognito, EFS, Glue, Athena, AMIs | Carried (P22): batch 4's own kinds already have icons; adding icons means re-running the pinned icon-pack extraction (batch 1 Task 9), a web-only change |
| Batch 3 review minor 1: lab 19's load-balancer guard rests on the lab's text | Carried: a scope rule would read a role's attached policy documents across resources; the cluster role's deny is in lab 19's reviewed folder and any change needs a version bump and a release test; Unblock's `k8s_lbs` still runs whenever the cluster is listed |
| Batch 3 review minor 2: REST API stages, API keys and usage plans without tag checks | Carried: no lab makes a REST API and the account has none (Task 23 Step 3 re-reads `apigateway get-rest-apis`); a REST API lab adds them to `changesOn`/`postCreatesOn` |
| Batch 3 review minor 3: name exceptions wider in IAM than at scope (`table/lab-*`, `CopyImage`) | Carried: the scope check holds both to `lab-<id>-*`; the optional Verify-clean warning for `lab-*` tables or self-owned AMIs matching no lab id is low value |
| Batch 3 review minor 5: EKS node group without `instance_types`; ElastiCache replicas and global groups | **Done** (Task 4's `sizeProblems`) |
| Batch 3 review minor 6: second destinations not checked by reference | **Done** (Task 4: dead-letter queues, redrive, crawler queues, Cognito triggers, state machine logs) |
| Batch 3 review minor 12: no test pins saa-16's tab zoom | Carried: cosmetic, web-only, no batch 4 lab changes the layout rule |
| Batch 2 final review M-3 (a stack in a non-deletable in-progress state), M-5 (the sweep skips enabled KMS keys) | Unchanged: no batch 4 lab uses CloudFormation or KMS; M-5 is ruled (A69) |
| Batch 2 Task 4 minors; batch 1 Task 7 minors (`labPrices` broken refs, `saveOrphans` filter, truncated tagged page) | Unchanged; batch 4 adds a us-west-2 read for one lab only, which none of them worsens |
| Batch 1 Task 9 minor: live parents differ from planned for IGW/SG/EICE/RDS | Cosmetic; unchanged |
| Batch 1 Task 4 parked: five `lab-aws.yml` steps duplicate `lab.yml` | Steven's call (C20); the equality test holds them, and Task 7 changes only step 16, which is AWS-only |
| Batch 1 final Minor 8: A30's unpeer and destroy run together | Watch item; unchanged |
| Batch 1 final Minor 9: spec §7.5's "id as a parameter" wording | Spec wording; Task 23 Step 4 rewords it while editing §7 ("a VPC id passed as a parameter: Route 53, Resolver and Lattice associations, held by the scope check's by-reference rules, A111–A128") |
| New watch items (batch 4) | The accepter sides' tags (P3: whichever answer, the exemption stands); Global Accelerator's region signing (P9 fallback ready); WAF and Resolver billing granularity (Cost Explorer, Task 24 Step 8); the tagging API's listing of deleted transit gateway, VPN, IPAM, Lattice and Global Accelerator items past 90 minutes (Task 24 Step 6) |

## Spec coverage (self-review)

| Spec item | Where |
|---|---|
| §12.2 rows 20–31: areas, level, type, tier, peer, D/X, S/M, prerequisites, key resources | Design sheet; Tasks 11–22 (`lab.yaml` and the per-lab tests pin each; lab 20 the only associate) |
| §12.2 "Not built here": Direct Connect and accelerated VPN (22), Cloud WAN and RAM (21), Firewall Manager (27), Shield Advanced (26), Verified Access (31) | Readmes of Tasks 12, 13, 17, 18, 22; `never` types (Task 3); `enable_acceleration`, federated Client VPN refused (Task 4) |
| §12.2 lab 28's faults | Design sheet (verbatim, A28); Task 19 |
| §14 item 4: transit gateways (incl. inter-region peering) | Tasks 2 (P3), 3, 4 (P15), 6, 10, 12, 18, 20 |
| §14 item 4: site-to-site VPN | Tasks 2, 3, 4 (P11), 6, 10, 13 |
| §14 item 4: Route 53 Resolver, DNS Firewall, query logging | Tasks 1 (`AWS_DNS_LABS`), 2, 3, 4 (P8, P12), 5, 14 |
| §14 item 4: PrivateLink endpoint services | Tasks 3, 4 (P13), 6 (before load balancers), 15, 16 |
| §14 item 4: GWLB and the GENEVE appliance | Tasks 4 (P14), 6, 16; §15's build-time risk in Task 24 Step 5 |
| §14 item 4: Global Accelerator and us-west-2 | Tasks 1 (`AWS_GA_LABS`), 2, 3, 4 (P9), 5, 8, 17 |
| §14 item 4: CloudFront origin groups, Functions, WAF | Tasks 3, 4 (P9), 5 (P10), 17 |
| §14 item 4: Network Firewall | Tasks 2, 3, 4 (P16), 6, 18 |
| §14 item 4: traffic mirroring; flow logs to S3 and Athena | Tasks 3, 4 (P8, P17), 6, 19 |
| §14 item 4: VPC Lattice | Tasks 2, 3, 4 (P19), 5, 21 |
| §14 item 4: Client VPN with ACM import from `tls` | Tasks 3, 4 (P20), 6, 22 |
| §14 item 4: IPAM free tier, IPv6 dual stack, prefix lists | Tasks 3, 4 (P5, P6), 6, 11 |
| §14 item 4: migration `0025_lab_files.sql` | Task 7 |
| §4 `files` output (A13); §5 step 16; §6 secret route; §10 files behind Show with Download | Tasks 1, 3 (lint), 7, 9, 22 |
| §4 providers: us-east-1 and us-west-2 only for lab 26 | Tasks 3 (rule 1 unchanged, accepters added), 17; spec §4 reworded in Task 23 (P9) |
| §12.2 rows 20 and 26 where a ruling changes them (IPAM's IPv6 pool, P5; Global Accelerator to NLBs, P9) | Rulings P5, P9; the spec rows reworded in Task 23 Step 4 |
| §5.1 ready check: TGW, attachments, VPN, Client VPN, Network Firewall, CloudFront, GA, Lattice, Resolver | Already in `lab-ready-aws.sh`; Task 6 adds the peering accept and ACM |
| §6 orphans in four regions; topology call cap | Already four regions; Task 8 (us-west-2 reads, cap 16); Task 24 Step 6 |
| §7.1 create/change lists, service-linked list, account-setting denies | Task 2 (P3, P4, P8) |
| §7.3 rules 1, 4–13 for batch 4's types | Tasks 3, 4 |
| §7.4 public by nature: lab 22's router, ALB/NLB, NAT, CloudFront, GA, Client VPN | Tasks 3–4 (P6, P11), the labs; Task 23 Step 4 (GA's NLBs) |
| §7.5 a VPC id as a parameter (Resolver, Lattice) | Task 4 (by-reference rules) |
| §8.1–§8.3 for every new type, four regions | Tasks 5, 6 (P10, P23) |
| §9 whole hours, per-use charges in readmes | Design sheet cost items; Tasks 11–22 readmes |
| §10 topology kinds for batch 4 | Task 10 (P22) |
| §11 spend: ≤ £15 for the project | Global Constraints; Task 24 Step 1 and its expected spend |
| §15: Lab 25 appliance build time | Task 24 Step 5 (console output) |
| §17: plan rulings copied as A110 on | Task 23 Step 4 |
