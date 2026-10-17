The edge of AWS's network, used two ways to reach the same small site in London and Ireland. CloudFront caches nothing here, but it ends HTTPS at its edge locations, runs a CloudFront Function on every request, screens each one with a WAF web ACL, and fails over from London to Ireland on its own. Global Accelerator gives you two fixed anycast addresses: you enter AWS at the nearest edge and ride AWS's own network to the nearest healthy region. The regional parts are listed in the lab's resource groups, `lab-ans-26-edge`, in AWS Resource Groups (London and Ireland); the distribution is global, the web ACL is in us-east-1 and the accelerator in us-west-2, as their services require, so look for those in their own consoles.
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

- Compare the ways in from CloudShell or your PC: `curl` each Connect line a few times. Global Accelerator answers from London if you are nearest to it, and CloudFront answers from London because London is the origin group's primary. `curl -s -o /dev/null -w '%{time_connect} %{time_total}\n'` against each shows where the connection is set up: at an edge location for both, at the load balancer for the NLBs.
- Fail London: connect to `vm-london` and run `sudo systemctl stop lab-web`. CloudFront's next request comes back from Ireland straight away (the origin group's failover). Global Accelerator moves to Ireland once the London NLB reports its target unhealthy, within a minute or two (the TCP health check's defaults). Start it again with `sudo systemctl start lab-web` and watch both come back to London, again after a minute or two for Global Accelerator.
- Turn the dial instead: in the Global Accelerator console (it lives in us-west-2), open the accelerator, the listener, and the London endpoint group, and set its traffic dial to 0%. Every request now goes to Ireland though London is healthy: this is how you drain a region for maintenance. Set it back to 100%.
- Test the web ACL: `curl -s -o /dev/null -w '%{http_code}\n' "https://<the distribution's name>/?q=<script>alert(1)</script>"` gets 403 from the Core rule set. Then `for i in $(seq 400); do curl -s -o /dev/null -w '%{http_code}\n' https://<the distribution's name>/; done | sort | uniq -c`: once WAF has counted past 100 (detection can take up to several minutes, so run the loop again if you see only 200s), you get 403s until the 5-minute window passes. The WAF console (us-east-1, Global (CloudFront)) shows the sampled requests and which rule matched.
- See the function's header arrive: on `vm-london`, `sudo dnf install -y tcpdump && sudo tcpdump -l -A -n -i any tcp port 80 | grep -i x-cloudlabs-edge`, then request the distribution. Requests through Global Accelerator or the NLB directly carry no such header.

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
