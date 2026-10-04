## What it deploys

- Two Entra users, `lab-<id>-ann` and `lab-<id>-ben`
- A group, `lab-<id>-helpdesk`, with ann in it
- A custom role, `lab-<id>-vm-operator`
- Reader for the group and the custom role for ben, both at the lab's resource group

```text
rg-lab-<id>
  Reader ............... lab-<id>-helpdesk (ann)
  lab-<id>-vm-operator .. ben
```

## Things to try

- Sign in as ann and see what Reader lets her do
- Compare ben's custom role with the built-in Virtual Machine Contributor
- Check access for each user on the resource group's Access control page

## Learn more

- [Azure role-based access control](https://learn.microsoft.com/azure/role-based-access-control/overview)

This readme is a stub; the lab's author (plan area L5) writes the full one.

Anything you build by hand inside `rg-lab-az104-01-identity` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-01-identity-`.
