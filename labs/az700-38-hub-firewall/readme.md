Hub and spoke with Azure Firewall in the middle: a Basic firewall in the hub, rules kept in a parent and a child Firewall Manager policy, and two spokes whose route tables send everything through the firewall. Practise allowing and denying traffic by FQDN, address and port, seeing how a child policy inherits its parent's rules, and reading the firewall's logs. From the AZ-700 outline, in Design and implement Azure network security services: map requirements to the features of Azure Firewall, select a firewall SKU, design and create a firewall deployment, configure firewall rules, and create Firewall Manager policies; and from core networking, user-defined routes and peering.

## What it deploys

- `vnet-hub` (the first /20 of the session's address slot) with `AzureFirewallSubnet` and `AzureFirewallManagementSubnet` (each a /26)
- `afw-hub`, an Azure Firewall on the **Basic** tier with two Standard public IPs: `pip-afw-hub` for traffic and `pip-afw-hub-mgmt` for Azure's own management of the firewall, which Basic always needs
- Two Firewall Manager policies, both Basic. `fwp-base` is the parent: a network rule collection letting the spokes reach each other on TCP 22 and ping. `fwp-hub` inherits it and adds an application rule collection: the spokes may reach `*.ubuntu.com` and `www.microsoft.com` on HTTP and HTTPS. The firewall uses `fwp-hub`; anything no rule allows is denied
- `vnet-spoke1` and `vnet-spoke2` (the second and third /20s), each peered with the hub (forwarded traffic allowed) but not with each other. Each has `snet-workload` with **no default outbound access** and a route table (`rt-spoke1`, `rt-spoke2`) sending 0.0.0.0/0 and the other spoke's /20 to the firewall's private IP
- `vm-spoke1` and `vm-spoke2`: Standard_B1s Ubuntu 24.04 VMs with no public IP that serve their names on port 80
- `log-hub`, a Log Analytics workspace capped at 50 MB a day, and a diagnostic setting sending the firewall's application, network, NAT and threat intelligence logs to it in resource-specific tables (`AZFWApplicationRule`, `AZFWNetworkRule`, ...)

Deploying takes about 15 minutes, most of it the firewall. Tear-down takes about 12, the firewall before its policies. The spokes send everything to the firewall, so a tunnel client cannot reach their VMs: use the portal's serial console or Run command on `vm-spoke1`, and go on to `vm-spoke2` from there. **Peer to gateway** peers only `vnet-hub`, which holds nothing but the firewall. The VM user is `azureuser`; its password is behind **Show**.

```text
rg-lab-<id>
  vnet-hub (slot /20 0)
    AzureFirewallSubnet /26            AzureFirewallManagementSubnet /26
      afw-hub (Basic) -- policy fwp-hub (inherits fwp-base) --> pip-afw-hub --> internet
           ^                    ^
   peering |                    | peering
  vnet-spoke1 (slot /20 1)    vnet-spoke2 (slot /20 2)
    snet-workload, rt-spoke1    snet-workload, rt-spoke2
      0.0.0.0/0, spoke2 -> afw    0.0.0.0/0, spoke1 -> afw
      vm-spoke1 :80               vm-spoke2 :80
afw-hub logs --> log-hub (AZFW* tables)
```

## Things to try

- On `vm-spoke1` (serial console), run `curl -sI https://www.microsoft.com` (allowed) and `curl -sI https://example.com` (denied: no rule allows it, so the firewall refuses the connection; `curl http://example.com` shows its deny message). `sudo apt update` works too, through `*.ubuntu.com`.
- From `vm-spoke1`, `ssh azureuser@<vm-spoke2 address>` and `ping` it: both pass the parent's network rules. `curl http://<vm-spoke2 address>` does not, as no rule allows port 80 between the spokes. Open **Effective routes** on `nic-vm-spoke1` and find the routes to the firewall.
- After a few minutes, query `log-hub`: `AZFWApplicationRule | project TimeGenerated, Fqdn, Action, SourceIp` and `AZFWNetworkRule | project TimeGenerated, SourceIp, DestinationIp, DestinationPort, Action`.
- In **Firewall Manager**, add a rule collection to `fwp-hub` allowing port 80 between the spokes and watch the curl start working. Open `fwp-hub`'s rule collections and see `fwp-base`'s inherited ones listed first; try to edit an inherited rule from the child.
- Compare the SKUs: Basic (up to 250 Mbps, threat intelligence alerts only, no DNS proxy, a management subnet always), Standard (DNS proxy, web categories, threat intelligence deny) and Premium (TLS inspection, IDPS, URL filtering). Which would a requirement for TLS inspection need?

## Learn more

- [What is Azure Firewall?](https://learn.microsoft.com/azure/firewall/overview)
- [Azure Firewall Basic features](https://learn.microsoft.com/azure/firewall/basic-features)
- [Choose the right Azure Firewall SKU](https://learn.microsoft.com/azure/firewall/choose-firewall-sku)
- [Azure Firewall Manager policy overview](https://learn.microsoft.com/azure/firewall-manager/policy-overview)
- [Azure Firewall rule processing logic](https://learn.microsoft.com/azure/firewall/rule-processing)
- [Azure Firewall structured logs](https://learn.microsoft.com/azure/firewall/firewall-structured-logs)
- [Hub-spoke network topology in Azure](https://learn.microsoft.com/azure/architecture/networking/architecture/hub-spoke)

Anything you build by hand inside `rg-lab-az700-38-hub-firewall` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-38-hub-firewall-`.
