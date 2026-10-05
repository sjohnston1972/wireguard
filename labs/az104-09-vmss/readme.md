A Virtual Machine Scale Set that adds and removes instances on its own. Practise configuring a scale set, its upgrade
policy and its autoscale rules, then push the CPU up and watch Azure add an instance. From the AZ-104 outline: deploy and
configure an Azure Virtual Machine Scale Sets.

## What it deploys

- A small VNet, `vnet-lab` (the first /20 of the session's address slot), with one subnet, `snet-vms`
- `vmss-web`, a Uniform scale set of Standard_B1s Ubuntu 24.04 instances with no public IP, starting at 2. Its upgrade mode is **Manual**: a change to the model reaches an instance only when you upgrade it
- On each instance, cloud-init starts a small systemd service that serves the instance's own name on port 80 with python3, which Ubuntu already has: nothing is installed
- `autoscale-vmss-web`: 1 to 3 instances (default 2). One more when the average **Percentage CPU** over 5 minutes is above 70%, one fewer when it is below 25%, at most one change every 5 minutes. Left idle, the set soon scales in to 1

The instance user is `azureuser`; its password is behind **Show**. Instance addresses change as the set scales: the Connect lines show how to list them, as does the scale set's **Instances** blade. Deploy with **Peer to gateway** to reach them from a tunnel client, or use an instance's serial console or Run command.

```text
rg-lab-<id>
  vnet-lab (slot /20)
    snet-vms (/24)
      vmss-web (Uniform, B1s, no public IP, upgrade mode Manual)
        instance 0, instance 1 [, instance 2] --> python3 http.server on port 80
      autoscale-vmss-web: min 1, default 2, max 3
        avg CPU > 70% for 5 min: +1    avg CPU < 25% for 5 min: -1
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- Load one instance: open it under **Instances**, choose **Run command** then **RunShellScript**, and run `timeout 900 sh -c 'yes > /dev/null'`. A B1s has one vCPU, so that is 100%. Watch the CPU chart on the scale set and its **Scaling** blade's run history: after about 5 to 10 minutes a third instance appears, and it scales in again once the load stops.
- Change the instance count by hand under **Scaling** with a manual scale, and see the autoscale setting put it back at its next evaluation. Then turn autoscale off and try again.
- Edit the scale set's model (for example, a new tag or a changed boot diagnostics setting) and notice the instances show **Latest model: No**. With upgrade mode Manual nothing changes until you select them and choose **Upgrade**.
- Run `curl http://<instance address>` against each instance (while peered) and match the names to the **Instances** list.
- Create a Flexible scale set by hand in the lab's resource group and compare it with this Uniform one: what each lets you do with individual VMs, and how instances are named. Delete it before the session ends, or let tear-down remove it.

## Learn more

- [What are Virtual Machine Scale Sets?](https://learn.microsoft.com/azure/virtual-machine-scale-sets/overview)
- [Orchestration modes for Virtual Machine Scale Sets](https://learn.microsoft.com/azure/virtual-machine-scale-sets/virtual-machine-scale-sets-orchestration-modes)
- [Overview of autoscale with Virtual Machine Scale Sets](https://learn.microsoft.com/azure/virtual-machine-scale-sets/virtual-machine-scale-sets-autoscale-overview)
- [Upgrade policies for Virtual Machine Scale Sets](https://learn.microsoft.com/azure/virtual-machine-scale-sets/virtual-machine-scale-sets-upgrade-policy)
- [Autoscale in Azure Monitor](https://learn.microsoft.com/azure/azure-monitor/autoscale/autoscale-overview)
- [Run scripts in your Linux VM by using action Run Commands](https://learn.microsoft.com/azure/virtual-machines/linux/run-command)

Anything you build by hand inside `rg-lab-az104-09-vmss` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-09-vmss-`.
