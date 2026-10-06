Every kind of Azure load balancer in one lab: a global-tier (cross-region) load balancer in front of public Standard load balancers in uksouth and ukwest, the uksouth one with a second frontend chained to a Gateway load balancer that sends its traffic through an appliance VM, plus an inbound NAT rule over a port range and explicit outbound rules. From the AZ-700 outline, in Design and implement application delivery services: select an Azure Load Balancer SKU and tier, choose between public and internal, create and configure a load balancer (including cross-region), implement load-balancing rules, create and configure inbound NAT rules, create explicit outbound rules, and implement a Gateway Load Balancer.

Deploy this lab in uksouth: its second region is ukwest, uksouth's Azure pair, and uksouth is one of the global tier's home regions. Besides `rg-lab-az700-40-lb-advanced` it makes a second resource group in ukwest, `rg-lab-az700-40-lb-advanced-secondary`, which holds `vnet-ukw`, `vm-web2` and `lb-ukw`.

## What it deploys

- `vnet-uks` (uksouth, the first /20 of the session's address slot) with `snet-web` and `snet-nva`, and `vnet-ukw` (ukwest, the second /20) with its own `snet-web`; every subnet has default outbound access off, so the outbound rules are the only way out
- `vm-web1` (uksouth) and `vm-web2` (ukwest): Standard_B1s Ubuntu 24.04 VMs with no public IP that answer on port 80 with `<name> in <region>` (python3's built-in web server)
- `lb-uks`, a public Standard load balancer in uksouth over `vm-web1` with **two frontends**, each on its own Standard public IP: `fe-uks` (`pip-lb-uks`) has a rule for TCP 80 with outbound SNAT turned off, an HTTP probe on `/` and an **outbound rule** (1,024 SNAT ports per VM, TCP reset on), and is `lb-global`'s member; `fe-uks-chained` (`pip-lb-uks-chained`) is chained to `lb-gw` and has the **inbound NAT rule** (version 2: frontend ports 8081 to 8090 to port 80 on the pool, so `vm-web1` is 8081)
- `lb-ukw`, the same in ukwest over `vm-web2`, without the NAT rule or the chain
- `lb-global`, a **global-tier** load balancer on a Global public IP, homed in uksouth: one pool whose members are the two regional frontends, one rule for TCP 80 and no probe (it follows the regional load balancers' own health)
- `lb-gw`, a **Gateway load balancer** in `snet-nva` with a fixed private frontend (the 10th address of `snet-nva`), HA ports, a TCP 22 probe and a pool with two VXLAN tunnel interfaces: internal (VNI 800, UDP 10800) and external (VNI 801, UDP 10801). `lb-uks`'s `fe-uks-chained` is chained to it. Gateway Load Balancer doesn't work with the Global Load Balancer tier, so the frontend `lb-global` points at, `fe-uks`, is never the chained one
- `vm-nva`, the appliance: IP forwarding on its NIC, and a Linux bridge between two VXLAN interfaces (`vxlan800`, `vxlan801`) built by cloud-init at every boot, so whatever arrives on one tunnel leaves on the other unchanged
- NSGs: `nsg-web-uks` and `nsg-web-ukw` allow TCP 80 from the internet and nothing else; `nsg-nva` allows the VXLAN ports from inside the VNet. SSH is never open to the internet

The NAT rule's frontend ports 8081 to 8090 need no NSG rule of their own: an NSG sees the packet after the load balancer translates it, when it is already port 80. The load balancers take a few minutes to create; the Gateway load balancer and the global tier are the slowest. Deploy with **Peer to gateway** to SSH to `vm-web1` and `vm-nva` from a tunnel client (vnet-ukw is never peered: reach `vm-web2` with the serial console or Run command). The VM user is `azureuser`; its password is behind **Show**.

```text
                         you (curl, browser)
                                 |
         lb-global (Global tier, Global public IP, home: uksouth)
           pool-regions: two frontends     rule TCP 80, no probe
              |                                     |
rg-lab-<id> (uksouth)                    rg-lab-<id>-secondary (ukwest)
  lb-uks                                   lb-ukw (public, fe-ukw)
    fe-uks (pip-lb-uks): rule 80 (no SNAT),  rule 80, probe /
      probe /, outbound rule                 outbound rule
    fe-uks-chained (pip-lb-uks-chained):          |
      NAT 8081-8090 -> 80  --chain-->             |
         lb-gw (Gateway, snet-nva .10)            |
           VXLAN 800/10800, 801/10801             |
           vm-nva: vxlan800 <-br-gwlb-> vxlan801  |
  vnet-uks / snet-web                      vnet-ukw / snet-web
    vm-web1 :80                              vm-web2 :80
  peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- Curl the global address in a loop, then stop `vm-web1`'s web server (`sudo systemctl stop lab-http`) and watch `lb-uks`'s probe fail and the global tier send everything to ukwest. Start it again. Which region answers when both are healthy, and why does that depend on where you are?
- Curl `pip-lb-uks-chained` on ports 8081 and 8082: the inbound NAT rule's range maps one port per pool member to port 80. Open the rule's port mapping in the portal, and add a member to see 8082 appear.
- On `vm-nva`, run `sudo tcpdump -ni eth0 udp portrange 10800-10801` while you curl `pip-lb-uks-chained` on 8081, then `sudo tcpdump -ni br-gwlb port 80` to see the same packets unwrapped. Curl `pip-lb-uks` on 80 and see nothing on the appliance: `fe-uks` is not chained. Remove the chain from `fe-uks-chained` (or stop `lab-vxlan`) and compare. Why is `fe-uks` not chained too? Gateway Load Balancer doesn't work with the Global Load Balancer tier, and `fe-uks` is `lb-global`'s member. If curls through `lb-uks` hang on larger responses, look at the MTU: VXLAN adds 50 bytes to every packet.
- Read `lb-uks`'s outbound rule: from `vm-web1`, `curl -s ifconfig.me` shows the frontend's address. Change the allocated ports and read the SNAT connection metrics. Why does the load-balancing rule turn outbound SNAT off?
- Compare the four: regional and global tiers, public and internal frontends, Standard and Gateway SKUs. What does each pass on, and what can only the global tier do (an anycast address, no outbound rules, backends that are other load balancers)?

## Learn more

- [Azure Load Balancer SKUs](https://learn.microsoft.com/azure/load-balancer/skus)
- [Cross-region (global) load balancer](https://learn.microsoft.com/azure/load-balancer/cross-region-overview)
- [Gateway Load Balancer](https://learn.microsoft.com/azure/load-balancer/gateway-overview)
- [Inbound NAT rules](https://learn.microsoft.com/azure/load-balancer/inbound-nat-rules)
- [Outbound rules](https://learn.microsoft.com/azure/load-balancer/outbound-rules)
- [Source Network Address Translation (SNAT) for outbound connections](https://learn.microsoft.com/azure/load-balancer/load-balancer-outbound-connections)
- [Azure Load Balancer health probes](https://learn.microsoft.com/azure/load-balancer/load-balancer-custom-probe-overview)

Anything you build by hand inside `rg-lab-az700-40-lb-advanced` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-40-lb-advanced-`.
