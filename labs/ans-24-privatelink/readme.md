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
