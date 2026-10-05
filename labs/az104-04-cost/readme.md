A monthly budget on the lab's resource group, wired to an action group, so you can see how budgets, thresholds and alerts
fit together, and a reason to explore cost analysis and Advisor. From the AZ-104 outline: manage costs by using alerts,
budgets and Azure Advisor recommendations, and set up action groups.

## What it deploys

- A budget, `lab-az104-04-cost-monthly`, of 5 a month in your billing currency (pounds for a UK account) on
  `rg-lab-az104-04-cost`, starting on the 1st of this month
- Three thresholds on it: 50% and 80% of actual spend, and 100% of forecast spend
- An action group, `lab-az104-04-cost-budget-alerts` (short name `labbudget`), that every threshold alerts. It has no
  receivers, so nothing is emailed or called until you add one

```text
rg-lab-az104-04-cost
  budget lab-az104-04-cost-monthly (5 a month, from the 1st)
    50% actual ─────┐
    80% actual ─────┼──▶ action group lab-az104-04-cost-budget-alerts
    100% forecast ──┘      (no receivers yet)
```

Cost: nothing. Budgets and action groups are free; an action group charges only for some notifications (SMS and voice) if
you add them.

Cost data reaches Cost Management several hours late, often up to a day, so this lab's own group shows no spend while it
runs. Look at the subscription, the gateway's group and earlier labs instead.

## Things to try

- Open **Cost Management**, then **Budgets**, with the scope set to `rg-lab-az104-04-cost`. Read the budget, change the
  amount, and add a 90% forecast threshold
- Open the action group, add yourself as an **Email** receiver, and use **Test action group** to send a sample budget alert
- Open **Cost analysis** at subscription scope: group by resource group and switch to daily costs. Find the gateway's group
  and any `rg-lab-` groups from earlier sessions
- Every lab resource carries the tags `project`, `lab` and `session`: group cost analysis by the `lab` tag and compare
- Open **Advisor**, then **Cost**: read the recommendations and decide which would apply to the gateway VM

## Learn more

- [Tutorial: Create and manage budgets](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets)
- [Quickstart: Start using Cost analysis](https://learn.microsoft.com/azure/cost-management-billing/costs/quick-acm-cost-analysis)
- [Use cost alerts to monitor usage and spending](https://learn.microsoft.com/azure/cost-management-billing/costs/cost-mgt-alerts-monitor-usage-spending)
- [Action groups](https://learn.microsoft.com/azure/azure-monitor/alerts/action-groups)
- [Reduce service costs by using Azure Advisor](https://learn.microsoft.com/azure/advisor/advisor-cost-recommendations)

Anything you build by hand inside `rg-lab-az104-04-cost` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-04-cost-`.
