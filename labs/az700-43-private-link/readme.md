Three ways to reach a service privately, side by side: a Private Link service that publishes a web server from a provider VNet to a consumer VNet that is never peered with it, a private endpoint for a storage account with its private DNS zone, and a service endpoint with a service endpoint policy that lets a subnet reach one storage account and no other. From the AZ-700 outline, in Design and implement private access to Azure services: create a Private Link service, plan and create private endpoints, configure access to them and integrate them with DNS, create service endpoints, configure service endpoint policies and choose when to use a service endpoint. From the AZ-305 outline: private connectivity in network solutions and securing access to storage in data storage solutions.

## What it deploys

- `vnet-provider` (the first /20 of the session's address slot) with `snet-svc` and `snet-pls`; `vnet-consumer` (the second /20) with `snet-pe` and `snet-client`. The two VNets are **not peered**
- `vm-svc` in `snet-svc`, a Standard_B1s Ubuntu 24.04 VM serving a page on port 80, behind `lb-svc`, an internal Standard load balancer (fixed frontend, the 10th address of `snet-svc`)
- `pls-svc`, a **Private Link service** on `lb-svc`'s frontend, its NAT address in `snet-pls` (network policies off there, as Private Link needs). It is visible to, and automatically approves, only the subscription the lab runs in
- `pe-svc`, a **private endpoint** in `snet-pe` connected to `pls-svc`: the consumer reaches the provider at an address of its own VNet
- `<prefix>st` and `<prefix>other`, two StorageV2 LRS accounts in the lab's region, each with a private container `data`
- `pe-blob`, a private endpoint in `snet-pe` to `<prefix>st`'s blob service, written into a private DNS zone, `privatelink.blob.core.windows.net`, linked to `vnet-consumer`, so `<prefix>st.blob.core.windows.net` resolves to the endpoint inside the VNet
- `snet-client` with a **Microsoft.Storage service endpoint** and `sep-storage`, a **service endpoint policy** allowing `<prefix>st` only; `vm-client`, a Standard_B1s VM in it with no public IP

Deploy with **Peer to gateway** to work from a tunnel client: the pipeline peers `vnet-consumer` and links the blob zone to the gateway VNet, so you can curl `pe-svc`, SSH to `vm-client` and resolve `<prefix>st`'s blob name to `pe-blob`. The provider is reached only through `pls-svc`. The blob zone has the same name as lab 6's, and only one lab at a time can link a zone name to the gateway VNet, so run this lab and lab 6 one after the other. The VM user is `azureuser`; its password is behind **Show**.

```text
rg-lab-<id>
  vnet-provider (slot /20 0)                 vnet-consumer (slot /20 1)    (not peered)
    snet-svc   lb-svc .10:80 --> vm-svc        snet-pe     pe-svc  --Private Link--> pls-svc
    snet-pls   pls-svc (NAT address)                       pe-blob --> <prefix>st (blob)
                                               snet-client vm-client
                                                 service endpoint Microsoft.Storage
                                                 sep-storage: <prefix>st only (not <prefix>other)
  privatelink.blob.core.windows.net (linked to vnet-consumer): <prefix>st -> pe-blob
       peering (optional): vnet-consumer <--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- `curl http://<pe-svc address>` from a tunnel client or `vm-client`: vm-svc answers through Private Link. On `vm-svc` (serial console), `journalctl -u lab-http` shows every request coming from `pls-svc`'s **NAT** address in `snet-pls`, never the client's own address. What would the provider need to see the real client (TCP proxy protocol v2)?
- On `vm-client`, `nslookup <prefix>st.blob.core.windows.net` returns `pe-blob`'s private address (through the `privatelink` CNAME); from your own PC it returns a public one. Compare `nslookup <prefix>other.blob.core.windows.net`: no private endpoint, so a public address.
- From `vm-client`, `curl -sI https://<prefix>other.blob.core.windows.net/data` and `curl -sI https://<prefix>st.blob.core.windows.net/data`. The second account is refused by the service endpoint policy (403); the first reaches storage (which then asks for credentials). Which path does each request take: service endpoint or private endpoint?
- On `pls-svc`, **Reject** the `pe-svc` connection and watch the curl fail; then approve it again (and read why this subscription is auto-approved). Remove the subscription from the auto-approval list and create a second endpoint by hand: it waits as Pending.
- Choose: service endpoints (free, the public endpoint over the backbone, a subnet-wide switch, policies per account) or private endpoints (an address in your VNet, reachable from peered and on-premises networks, DNS to manage, billed per hour).

## Learn more

- [What is Azure Private Link service?](https://learn.microsoft.com/azure/private-link/private-link-service-overview)
- [What is a private endpoint?](https://learn.microsoft.com/azure/private-link/private-endpoint-overview)
- [Azure private endpoint DNS configuration](https://learn.microsoft.com/azure/private-link/private-endpoint-dns)
- [Virtual network service endpoints](https://learn.microsoft.com/azure/virtual-network/virtual-network-service-endpoints-overview)
- [Virtual network service endpoint policies for Azure Storage](https://learn.microsoft.com/azure/virtual-network/virtual-network-service-endpoint-policies-overview)
- [Manage a private endpoint connection](https://learn.microsoft.com/azure/private-link/manage-private-endpoint)

Anything you build by hand inside `rg-lab-az700-43-private-link` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-43-private-link-`.
