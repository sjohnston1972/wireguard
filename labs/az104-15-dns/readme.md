Azure DNS both ways: a public zone with A and CNAME records, and a private zone that a VM registers itself in. Practise
creating zones and record sets, asking a zone's own name servers, and linking a private zone to a VNet with
auto-registration. From the AZ-104 outline: configure Azure DNS.

This lab also counts for AZ-700, in Design and implement core networking infrastructure. From the AZ-700 outline: design
and implement Azure DNS: public zones and record sets, and private DNS zones linked to virtual networks with
auto-registration. For more, lab 32 resolves between Azure and an on-premises network with DNS Private Resolver.

## What it deploys

- A public DNS zone named `<prefix>.example.com` (the session's name prefix). `example.com` is reserved for documentation, so the zone can never shadow a real domain. It is not delegated: nothing on the internet points at it, so only its own Azure name servers answer for it, when you ask them directly
- In it, an A record `www` pointing at `203.0.113.10` (an address reserved for documentation, which reaches nothing) and a CNAME `app` pointing at `www`
- A private DNS zone, `lab15.internal`, linked to `vnet-lab` with **auto-registration** on, and an A record `www` made by hand that points at the VM
- A VNet, `vnet-lab` (the first /20 of the session's address slot), with `snet-vms`
- A Standard_B1s Ubuntu 24.04 VM, `vm-web`, with no public IP, which registers itself as `vm-web.lab15.internal` and serves its name on port 80 with python3's built-in web server

The VM user is `azureuser`; its password is behind **Show**. Deploy with **Peer to gateway** to resolve the private names from a tunnel client: the pipeline links `lab15.internal` to the gateway's VNet while peered, and the gateway's tunnel DNS forwards `internal` names to Azure DNS. Without peering, use the portal's serial console or Run command on `vm-web`.

```text
rg-lab-<id>
  <prefix>.example.com (public, not delegated)    ns1-xx.azure-dns.com ... answer for it
    www  A      203.0.113.10
    app  CNAME  www.<prefix>.example.com
  lab15.internal (private) --link, auto-registration--> vnet-lab (slot /20)
    vm-web  A  (registered by Azure)                      snet-vms
    www     A  (by hand) -> vm-web                          vm-web (B1s, no public IP) :80
       peering (optional) <--> gateway VNet (+ the pipeline's link) <--> tunnel DNS <--> you
```

## Things to try

- From anywhere, run the first Connect line, `nslookup www.<zone> <name server>`, then the same without the name server: the second fails, because the zone is not delegated. Try `app` too and see the CNAME followed.
- Open the public zone in the portal: find its **NS** and **SOA** record sets, add a TXT record and query it with `nslookup -type=TXT`.
- On `vm-web` (ssh while peered, or the serial console) run `resolvectl query vm-web.lab15.internal` and `curl http://www.lab15.internal`. In the portal, find the `vm-web` record Azure registered beside your `www`.
- While peered, from a tunnel client: `nslookup vm-web.lab15.internal`, then `curl http://www.lab15.internal`. Open the private zone's **Virtual network links** to see the gateway link the pipeline added.
- Add a record by hand in `lab15.internal` (an A record `db` with any address in `snet-vms`) and resolve it from `vm-web`, then change its TTL and watch the answer's TTL count down.
- Make a second private zone (say `lab15b.internal`) and link it to `vnet-lab` with auto-registration on: Azure refuses, because a VNet registers into one private zone only. Link it without registration instead.

## Learn more

- [What is Azure DNS?](https://learn.microsoft.com/azure/dns/dns-overview)
- [DNS zones and records overview](https://learn.microsoft.com/azure/dns/dns-zones-records)
- [Delegation of DNS zones with Azure DNS](https://learn.microsoft.com/azure/dns/dns-domain-delegation)
- [What is an Azure Private DNS zone?](https://learn.microsoft.com/azure/dns/private-dns-privatednszone)
- [What is the auto registration feature in Azure DNS private zones?](https://learn.microsoft.com/azure/dns/private-dns-autoregistration)
- [What is IP address 168.63.129.16?](https://learn.microsoft.com/azure/virtual-network/what-is-ip-address-168-63-129-16)

Anything you build by hand inside `rg-lab-az104-15-dns` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-15-dns-`.
