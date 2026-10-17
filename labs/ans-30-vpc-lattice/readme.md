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
