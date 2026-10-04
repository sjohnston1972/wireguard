## What it deploys

- A policy definition, `lab-<id>-require-costcentre-tag`, assigned at the lab's resource group
- The built-in Allowed locations policy, assigned at the lab's resource group
- A storage account with a CanNotDelete lock

```text
rg-lab-<id>
  policy: require costcentre tag
  policy: allowed locations
  storage account (locked)
```

## Things to try

- Create a resource without the costcentre tag and read the refusal
- Try to delete the locked storage account
- Look at the compliance view for both assignments

## Learn more

- [Azure Policy](https://learn.microsoft.com/azure/governance/policy/overview)

This readme is a stub; the lab's author (plan area L5) writes the full one.

Anything you build by hand inside `rg-lab-az104-02-policy` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-02-policy-`.
