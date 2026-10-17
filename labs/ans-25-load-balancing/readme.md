All three kinds of Elastic Load Balancing in one VPC, each doing the job it is chosen for. An Application Load Balancer ends HTTPS with a certificate you imported, splits traffic 80/20 between a blue and a green target group and sends one path to green alone. A Network Load Balancer keeps one fixed public address, passes TLS and plain TCP, and can tell the server who really called with proxy protocol. A Gateway Load Balancer sends one subnet's internet traffic through an inspection appliance and back, without either end noticing. Everything is listed in the lab's resource group, `lab-ans-25-load-balancing`, in AWS Resource Groups (London).
From the ANS-C01 outline: design and implement load balancing for performance, availability and security, including TLS termination, static addressing and third-party appliances behind a Gateway Load Balancer.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20) with seven subnets: `snet-private-1/2` (the web instances live in the first; the second gives the ALB its second zone), `snet-public-1/2` (the ALB, the NLB and the NAT gateway `nat-lab`), and in the first zone `snet-appliance`, `snet-gwlbe` and `snet-inspected`
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
                                                  --20%, and /green/*--> vm-green (snet-private-1)
  you --TLS 443--> nlb-app (eip-nlb) --TCP 80--> vm-blue
  you --TCP 8080--> nlb-app --proxy protocol v2--> vm-green
  vm-client (snet-inspected) --0.0.0.0/0--> vpce-gwlb --> gwlb-appliance --GENEVE 6081--> vm-appliance
      --> back to vpce-gwlb --> nat-lab --> igw-lab --> internet (replies: rt-public --> vpce-gwlb --> vm-client)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Count the split: `for i in $(seq 20); do curl -sk https://<the ALB's name>/; done | sort | uniq -c` gives about 16 blue and 4 green. Ask for `https://<the ALB's name>/green/` and it is always green. `curl -sI http://<the ALB's name>/` shows the 301 redirect to HTTPS.
- Read the certificate both load balancers present: `openssl s_client -connect <the NLB's address>:443 -servername app.<name prefix>.internal </dev/null | openssl x509 -noout -subject -issuer -dates`. In ACM (London) it is listed as Imported: ACM never renews an imported certificate, so you would import its replacement yourself.
- Try proxy protocol: `curl http://<the NLB's address>:8080/` fails with `curl: (52) Empty reply from server`, because `vm-green`'s simple web server does not understand the extra header. On `vm-green` (Instance Connect) run `sudo dnf install -y tcpdump && sudo tcpdump -X -n -i any tcp port 80` and call it again: the first bytes are the proxy protocol v2 signature (`\r\n\r\n\0\r\nQUIT\n`), followed by your own public address as 4 bytes in hex. Real servers (nginx, HAProxy) read that header to log the true client.
- Follow a packet through the appliance: on `vm-client`, `curl -sI https://aws.amazon.com`; on `vm-appliance`, `sudo tcpdump -n -i any udp port 6081` shows the same traffic wrapped in GENEVE, and `ip link` shows the `gwi-` interfaces `gwlbtun` made. Then `sudo systemctl stop gwlbtun` on the appliance: `vm-client` loses the internet, yet the target stays healthy, because the health check on port 8080 never touches the data path. Start it again with `sudo systemctl start gwlbtun`.
- Time the appliance's build: `aws ec2 get-console-output --instance-id <vm-appliance's id> --latest --output text | tail -40` in CloudShell shows the compile; `systemctl status gwlbtun` on the appliance shows when it started.

## Learn more

- [Listeners for your Application Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html)
- [Target groups for your Network Load Balancers (client IP preservation and proxy protocol)](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-target-groups.html)
- [What is a Gateway Load Balancer?](https://docs.aws.amazon.com/elasticloadbalancing/latest/gateway/introduction.html)
- [Access virtual appliances through Gateway Load Balancer endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/vpce-gateway-load-balancer.html)
- [Importing certificates into AWS Certificate Manager](https://docs.aws.amazon.com/acm/latest/userguide/import-certificate.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-25-load-balancing` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
