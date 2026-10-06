Monitoring at scale, the way a platform team does it: one central Log Analytics workspace, and a policy that makes every Key Vault send its logs there instead of relying on someone to remember. From the AZ-305 outline: design solutions for logging and monitoring (a logging solution, routing logs, a monitoring solution) and design governance (managing compliance).

## What it deploys

- A Log Analytics workspace, `log-central` (pay-as-you-go, 30 days' retention), with a **daily cap of 0.05 GB**, deleted for good on tear-down
- A custom policy definition, `lab-az305-21-monitoring-scale-kv-diagnostics`, with the **deployIfNotExists** effect: if a Key Vault has no diagnostic setting sending its `allLogs` category group to the given workspace, policy deploys one, named `setbypolicy-alllogs`. The workspace is a parameter of the definition, so one definition serves any workspace
- That definition assigned at `rg-lab-az305-21-monitoring-scale` with `log-central` as its parameter and a **system-assigned managed identity**, which holds one role, **Monitoring Contributor**, at the resource group: exactly the role the definition lists, and enough to write diagnostic settings and run the deployment
- The built-in **Resource logs in Key Vault should be enabled** (AuditIfNotExists) assigned at the group, to report the result
- A Key Vault (Standard, Azure RBAC, 7 days' soft-delete retention, no purge protection), created after the assignment and its role so policy evaluates it as it is made

```text
rg-lab-az305-21-monitoring-scale
  lab-...-kv-diagnostics (deployIfNotExists, assigned here)
    managed identity -- Monitoring Contributor (this group only)
        |
        | about 15 minutes after the vault is made:
        v
  <prefix>kv (Key Vault) --setbypolicy-alllogs--> log-central (cap 0.05 GB/day)
        ^
  lab-...-kv-logs-audit (built-in audit: compliant once the setting exists)
```

Policy remediates the new vault without a remediation task: a deployIfNotExists policy evaluates a resource when it is created and, after a short delay, deploys what is missing. Diagnostics arrive about 15 minutes after deploy (the policy's evaluation delay, then the deployment), so give it a quarter of an hour before looking for the setting; the first log records usually follow within minutes, though Azure allows up to 90. Nothing is assigned above the resource group, and the deployment lands in the vault's own group.

Cost: under a penny an hour. The workspace receives a few hundred KB of audit events; the cap bounds it at about £0.11 a day.

## Things to try

- After 15 minutes, open the vault's **Diagnostic settings** and find `setbypolicy-alllogs`, then open the resource group's **Deployments** and find the one policy ran. Open **Policy**, then **Compliance**, and see both assignments report the vault compliant
- In `log-central`, open **Logs** and run `AzureDiagnostics | where ResourceProvider == "MICROSOFT.KEYVAULT" | summarize count() by OperationName`. Open the vault's **Secrets** blade (it will refuse you until you give yourself a data role) and watch the refused call appear a few minutes later
- Delete `setbypolicy-alllogs` from the vault, wait for the next evaluation (or start one with `az policy state trigger-scan -g rg-lab-az305-21-monitoring-scale`), see the vault go non-compliant, then create a **remediation task** for `lab-az305-21-monitoring-scale-kv-diagnostics` and watch it put the setting back. Never turn on purge protection on a vault you make by hand: nothing could delete it for its retention period
- Open the assignment's **Managed identity** tab and follow it to the resource group's **Access control (IAM)**: one identity, one role, one scope. Read why Monitoring Contributor is enough here and when a definition would need more
- Sketch the design choice this lab makes for you: one central workspace with resource-context access (each team reads only its own resources' logs) against a workspace per team, and where the daily cap, retention and the Azure Monitor agent's data collection rules fit

## Learn more

- [Design a Log Analytics workspace architecture](https://learn.microsoft.com/azure/azure-monitor/logs/workspace-design)
- [Manage access to Log Analytics workspaces](https://learn.microsoft.com/azure/azure-monitor/logs/manage-access)
- [Diagnostic settings in Azure Monitor](https://learn.microsoft.com/azure/azure-monitor/platform/diagnostic-settings)
- [Azure Policy deployIfNotExists effect](https://learn.microsoft.com/azure/governance/policy/concepts/effect-deploy-if-not-exists)
- [Remediate non-compliant resources with Azure Policy](https://learn.microsoft.com/azure/governance/policy/how-to/remediate-resources)
- [Azure Key Vault logging](https://learn.microsoft.com/azure/key-vault/general/logging)

Anything you build by hand inside `rg-lab-az305-21-monitoring-scale` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az305-21-monitoring-scale-`.
