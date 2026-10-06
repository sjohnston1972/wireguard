A break-fix lab: an app VM that should reach its database VM's service, and cannot. Find out why with Network Watcher's
tools, fix it in the portal, and prove the fix. From the AZ-104 outline: troubleshoot network connectivity, evaluate
effective security rules in NSGs, configure user-defined network routes, and use Azure Network Watcher.

This lab also counts for AZ-700, in Design and implement core networking infrastructure and Design and implement Azure
network security services. From the AZ-700 outline: monitor and troubleshoot networks with Network Watcher (next hop,
connection troubleshoot and IP flow verify), and evaluate network security group rules. For more, lab 44 adds VNet flow
logs with traffic analytics and Azure Bastion.

## What it deploys

- A VNet, `vnet-lab` (the first /20 of the session's address slot), with `snet-app` and `snet-db` (each a /24)
- `vm-app` in `snet-app` (serves its name on port 80) and `vm-db` in `snet-db` (serves its name on port 8080): Standard_B1s Ubuntu 24.04 VMs with no public IP, using python3's built-in web server
- `nsg-db` on `snet-db`, with rules meant to let `vm-app` in on 8080 and the VNet in on ssh, and a route table on `snet-app`
- The **Network Watcher agent** extension on both VMs, so connection troubleshoot works from either
- No Network Watcher of its own: Azure keeps one per region, `NetworkWatcher_<region>`, in its own resource group, `NetworkWatcherRG`, made when the region's first VNet was. Use it, and leave that group alone: it is outside the lab and tear-down never touches it

Somewhere in what this lab built, something is wrong. While the lab is peered you can ssh to both VMs from a tunnel client; otherwise use the portal's serial console or Run command. The VM user is `azureuser`; its password is behind **Show**.

```text
rg-lab-<id>
  vnet-lab (slot /20)
    snet-app (/24)  [route table]
      vm-app :80  (Network Watcher agent)
          |
          |  curl http://vm-db:8080   ...times out
          v
    snet-db (/24)  [nsg-db]
      vm-db :8080  (Network Watcher agent)
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
```

## Symptom

`curl http://vm-db:8080` from `vm-app` times out. `vm-db` is up and its service is running: on `vm-db` itself, `curl http://localhost:8080` answers `vm-db`. Find out what stops the request on the way, fix it, and show that the curl from `vm-app` now answers.

<details>
<summary>What was broken</summary>

Two faults, and the curl only works once both are fixed:

- **An NSG rule with a misleading name.** `nsg-db` has `allow-monitoring` at priority 100, which in fact **denies** TCP 8080 from **VirtualNetwork**. NSG rules are evaluated by priority, lowest number first, so it wins over `allow-app-8080` at 200. **IP flow verify** (inbound, TCP, from `vm-app`'s address to `vm-db` on 8080) names the rule; **Effective security rules** on `vm-db`'s network interface shows it in order. Fix: delete it, or change its action to Allow.
- **A route to an appliance that is not there.** `rt-app`, on `snet-app`, sends `snet-db`'s prefix to a virtual appliance at an address in the VNet's last /24, which no subnet uses (the firewall it was meant for was removed). **Next hop** from `vm-app` to `vm-db`'s address shows next hop type **VirtualAppliance** and that address, from `rt-app`; **Effective routes** on `vm-app`'s network interface shows the user route for the /24 winning over the VNet's own route for the whole /20, because the longer prefix wins. Fix: delete the route, or dissociate `rt-app` from `snet-app`.

**Connection troubleshoot** from `vm-app` to `vm-db` on 8080 reports the first problem on the path, so run it again after each fix: it stays Unreachable until both are gone.

</details>

## Things to try

- Fix one fault only and run **Connection troubleshoot** again: see which fault it reports now, and which tool would have found each one on its own.
- Run **IP flow verify** the other way (from `vm-db` to `vm-app` on port 80) and explain why that direction always worked.
- Open **NSG diagnostics** in Network Watcher for the same flow and compare it with IP flow verify.
- Open **Topology** for `rg-lab-<id>` in Network Watcher and find the route table and the NSG on the diagram.
- After both fixes, put a real deny back by hand (say from `snet-app` to `vm-db` on 22) and check that IP flow verify names your new rule.

## Learn more

- [What is Azure Network Watcher?](https://learn.microsoft.com/azure/network-watcher/network-watcher-overview)
- [IP flow verify overview](https://learn.microsoft.com/azure/network-watcher/ip-flow-verify-overview)
- [Next hop overview](https://learn.microsoft.com/azure/network-watcher/next-hop-overview)
- [Connection troubleshoot overview](https://learn.microsoft.com/azure/network-watcher/connection-troubleshoot-overview)
- [NSG diagnostics overview](https://learn.microsoft.com/azure/network-watcher/nsg-diagnostics-overview)
- [Manage the Network Watcher Agent virtual machine extension](https://learn.microsoft.com/azure/network-watcher/network-watcher-agent-manage)
- [Virtual network traffic routing](https://learn.microsoft.com/azure/virtual-network/virtual-networks-udr-overview)

Anything you build by hand inside `rg-lab-az104-17-netwatcher-fix` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-17-netwatcher-fix-`.
