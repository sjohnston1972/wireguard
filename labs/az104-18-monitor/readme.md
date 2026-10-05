A small Linux VM watched by Azure Monitor three ways: the platform metrics every VM emits for free, counters and syslog sent by the Azure Monitor agent to a Log Analytics workspace, and the activity log. Practise reading metrics, querying logs with KQL and wiring alerts to an action group. From the AZ-104 outline: interpret metrics in Azure Monitor, configure log settings, query and analyze logs, and set up alert rules and action groups.

## What it deploys

- A Standard_B1s Ubuntu 24.04 VM, `vm-monitor`, with no public IP, boot diagnostics on (so the portal's serial console works) and a system-assigned managed identity
- The Azure Monitor agent (`AzureMonitorLinuxAgent` extension), which signs in as the VM's identity
- A Log Analytics workspace, `log-lab` (pay-as-you-go, 30 days' retention), with a **daily cap of 0.05 GB**: past that, Azure drops new data until midnight UTC
- A data collection rule, `dcr-vm-linux`, associated with the VM: CPU and memory counters every 60 seconds into the `Perf` table, and syslog at Warning and above into `Syslog`
- An action group, `ag-lab`, with **no receivers**: alerts fire and show in the portal, and nobody is notified
- A metric alert, `alert-vm-cpu-high` (average CPU over 80% for 5 minutes), and an activity log alert, `alert-vm-restart` (any VM restart in this resource group), both sending to `ag-lab`
- A small VNet, `vnet-lab` (the first /20 of the session's address slot), with `snet-vms`

Nothing is written at subscription scope: there are no diagnostic settings, and the activity log is read where it already is. The VM user is `azureuser`; its password is behind **Show**. Deploy with **Peer to gateway** to reach the VM from a tunnel client, or use the portal's serial console or Run command. The agent takes a few minutes after deploy to send its first records.

```text
rg-lab-<id>
  vnet-lab (slot /20)
    snet-vms (/24)
      vm-monitor (B1s, no public IP, system-assigned identity)
        platform metrics -------------------> alert-vm-cpu-high --+
        Azure Monitor agent --dcr-vm-linux--> log-lab (cap 0.05 GB/day)
                                                Perf, Syslog, Heartbeat
  activity log (restart) -------------------> alert-vm-restart ---+--> ag-lab (no receivers)
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- Open `vm-monitor` → **Metrics**, chart **Percentage CPU** at a 1-minute grain, then run `timeout 600 yes > /dev/null` on the VM (Run command, or the `ssh` Connect line while peered). Watch the line climb and, about five minutes later, `alert-vm-cpu-high` fire under **Alerts**.
- In `log-lab` → **Logs**, run `Perf | where CounterName == "% Processor Time" | summarize avg(CounterValue) by bin(TimeGenerated, 1m) | render timechart`, then `Syslog | where SeverityLevel in ("warning", "err", "crit") | take 20`. Make a warning of your own with `logger -p user.warning "hello from the lab"` and find it.
- Restart `vm-monitor` from the portal and look for `alert-vm-restart` under **Alerts**, then find the same restart in the resource group's **Activity log**.
- Add an email receiver for yourself to the action group `ag-lab`, load the CPU again, and see the notification arrive. Then add an **alert processing rule** that suppresses notifications for the group and try once more.
- Check what the workspace is ingesting with `Usage | where TimeGenerated > ago(1d) | summarize sum(Quantity) by DataType`, and look at the daily cap under **Usage and estimated costs**.
- Turn on **VM insights** for `vm-monitor` and compare its charts with the metrics you have. Choose `log-lab` as the workspace and keep its new data collection rule in `rg-lab-az104-18-monitor`: the portal offers a default workspace in another resource group, which tear-down would not remove.

## Learn more

- [Azure Monitor overview](https://learn.microsoft.com/azure/azure-monitor/fundamentals/overview)
- [Azure Monitor Metrics](https://learn.microsoft.com/azure/azure-monitor/metrics/data-platform-metrics)
- [Azure Monitor agent overview](https://learn.microsoft.com/azure/azure-monitor/agents/azure-monitor-agent-overview)
- [Data collection rules in Azure Monitor](https://learn.microsoft.com/azure/azure-monitor/data-collection/data-collection-rule-overview)
- [Log Analytics tutorial](https://learn.microsoft.com/azure/azure-monitor/logs/log-analytics-tutorial)
- [Set a daily cap on a Log Analytics workspace](https://learn.microsoft.com/azure/azure-monitor/logs/daily-cap)
- [What are Azure Monitor alerts?](https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-overview)
- [Action groups](https://learn.microsoft.com/azure/azure-monitor/alerts/action-groups)
- [Activity log in Azure Monitor](https://learn.microsoft.com/azure/azure-monitor/fundamentals/activity-log)

Anything you build by hand inside `rg-lab-az104-18-monitor` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-18-monitor-`.
