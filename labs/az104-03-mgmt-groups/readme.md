## What it deploys

- Management groups `lab-<id>-root`, with `lab-<id>-prod` and `lab-<id>-dev` under it
- An audit policy defined and assigned at `lab-<id>-root`
- The lab's resource group; the subscription is never moved

```text
lab-<id>-root (audit policy)
  lab-<id>-prod
  lab-<id>-dev
```

## Things to try

- Find the hierarchy under Management groups in the portal
- See the policy assignment inherited by the child groups
- Read why a lab never moves the subscription

## Learn more

- [Management groups](https://learn.microsoft.com/azure/governance/management-groups/overview)

This readme is a stub; the lab's author (plan area L5) writes the full one.

Anything you build by hand inside `rg-lab-az104-03-mgmt-groups` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-03-mgmt-groups-`.
