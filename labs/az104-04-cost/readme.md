## What it deploys

- A budget of £5 a month on the lab's resource group
- An action group with no receivers, wired to the budget's thresholds

```text
rg-lab-<id>
  budget £5/month -> action group
```

## Things to try

- Open the budget and change a threshold
- Add yourself to the action group as an email receiver
- Look at the resource group's cost analysis

## Learn more

- [Cost Management budgets](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets)

This readme is a stub; the lab's author (plan area L5) writes the full one.

Anything you build by hand inside `rg-lab-az104-04-cost` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-04-cost-`.
