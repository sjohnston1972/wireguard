# Management groups and subscription governance

A small management group tree of the lab's own, with an audit policy assigned at its top, so you can see how policy and
access flow down a hierarchy. From the AZ-104 outline: configure management groups, and implement and manage Azure Policy.

## What it deploys

- Management groups `lab-az104-03-mgmt-groups-root`, under the tenant root group, with `lab-az104-03-mgmt-groups-prod` and
  `lab-az104-03-mgmt-groups-dev` under it
- A custom policy definition stored at the lab's root group, `lab-az104-03-mgmt-groups-audit-environment-tag`, that reports
  resources without an `environment` tag (audit only, it never refuses anything)
- An assignment of that policy at `lab-az104-03-mgmt-groups-root`, named `audit-environment-tag` and displayed as
  `lab-az104-03-mgmt-groups-audit-environment-tag` (names at management group scope are limited to 24 characters, so the
  lab's prefix is in the display name)
- The lab's resource group, `rg-lab-az104-03-mgmt-groups`, empty

```text
Tenant root group
  ├─ (your subscription stays where it is)
  └─ lab-az104-03-mgmt-groups-root ...... audit policy assigned here
       ├─ lab-az104-03-mgmt-groups-prod .. inherits it
       └─ lab-az104-03-mgmt-groups-dev ... inherits it
```

The subscription is never moved into the lab's tree. A policy or role assignment on a parent group reaches everything
below it, including the gateway, so the lab keeps its tree empty of subscriptions.

Cost: nothing. Management groups and policy are free.

To see the tree in the portal your account needs read access on it: the pipeline created it, so you may not have any yet.
As a Global Administrator you can turn on **Access management for Azure resources** in the Entra admin centre (Properties),
which gives you User Access Administrator at the root of the hierarchy. Turn it off again when you finish.

## Things to try

- Open **Management groups**, expand the tenant root group and find the lab's tree. Open each group's details and note the
  ids are the names you would use in templates and the CLI
- Open `lab-az104-03-mgmt-groups-prod`, then **Policy** and **Assignments**: the audit assignment appears, inherited from the
  root group. Look at the definition's JSON and its location
- Assign yourself **Reader** at `lab-az104-03-mgmt-groups-root`, then open **Access control (IAM)** on the dev group: the
  assignment shows as inherited
- Create a group by hand under the root group named `lab-az104-03-mgmt-groups-test`. A management group must be empty to
  delete; tear-down deletes `lab-az104-03-mgmt-groups-` groups children first, so give anything you add that prefix
- Open **Management groups**, then **Settings**: read the default management group and the "Require write permissions"
  setting. Look, but do not change them; the pipeline needs them as they are

## Learn more

- [What are Azure management groups?](https://learn.microsoft.com/azure/governance/management-groups/overview)
- [Create management groups](https://learn.microsoft.com/azure/governance/management-groups/create-management-group-portal)
- [Manage your Azure subscriptions at scale with management groups](https://learn.microsoft.com/azure/governance/management-groups/manage)
- [Protect your resource hierarchy](https://learn.microsoft.com/azure/governance/management-groups/how-to/protect-resource-hierarchy)
- [Elevate access to manage all Azure subscriptions and management groups](https://learn.microsoft.com/azure/role-based-access-control/elevate-access-global-admin)
- [Understand scope in Azure Policy](https://learn.microsoft.com/azure/governance/policy/concepts/scope)

Anything you build by hand inside `rg-lab-az104-03-mgmt-groups` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-03-mgmt-groups-`.
