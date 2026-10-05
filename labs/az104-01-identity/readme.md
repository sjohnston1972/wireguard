# Users, groups, roles and custom roles

Two Entra users, a group and a custom role, wired together with role assignments at the lab's resource group. Practise how
users, groups, built-in roles and custom roles combine, and how scope decides what someone can do. From the AZ-104 outline:
manage Microsoft Entra users and groups, and manage access to Azure resources (built-in roles, roles at different scopes,
interpreting access). Custom roles are no longer named in the outline, but reading a role's JSON is the quickest way to
understand any role.

## What it deploys

- Entra users `lab-az104-01-identity-ann` (Helpdesk) and `lab-az104-01-identity-ben` (Operations). Both sign in with the
  session password: press **Show** on the running lab for their user names and the password
- A security group, `lab-az104-01-identity-helpdesk`, with ann in it (ben is not)
- A custom role, `lab-az104-01-identity-vm-operator`: read resource groups and VMs, start, stop, deallocate and restart VMs,
  nothing else. It can be assigned only inside the lab's resource group
- Two role assignments at `rg-lab-az104-01-identity`: **Reader** for the helpdesk group, and the custom role for ben
- A network security group, `nsg-lab-demo`, so there is something to read and a resource to assign a role on. It is free

```text
Entra ID                                      rg-lab-az104-01-identity
                                                nsg-lab-demo
lab-az104-01-identity-ann
   └─ member of lab-az104-01-identity-helpdesk ── Reader ───────────▶ resource group
lab-az104-01-identity-ben ── lab-az104-01-identity-vm-operator ─────▶ resource group
```

Cost: nothing. Entra users and groups, role definitions and assignments and an empty network security group are free.

When ann or ben first signs in, Entra may ask them to register for multifactor authentication (MFA): security defaults,
which most small tenants have on, require it. Register with the Authenticator app, or use an InPrivate window and skip where
it offers to. The accounts are deleted at tear-down either way.

## Things to try

- Sign in to the portal as ann in an InPrivate window. She can open the resource group and `nsg-lab-demo`, but every change
  is refused: read the error and find which role she would need
- On the resource group's **Access control (IAM)** page, use **Check access** for ann and for ben. Note that ann's Reader comes
  from the group, and ben's from a direct assignment
- Open **Roles**, find `lab-az104-01-identity-vm-operator` and view its JSON. Compare its actions with the built-in
  **Virtual Machine Contributor**, then add `Microsoft.Network/networkSecurityGroups/read` and save
- Give ann **Network Contributor** on `nsg-lab-demo` only (resource scope). Sign in as ann again: she can add an inbound rule
  there but still cannot change the resource group
- Add ben to the helpdesk group, then check his access again: assignments from his group and his own add up
- Create a user by hand named `lab-az104-01-identity-cara`. Tear-down removes it because of its name; a user without the
  prefix would stay

## Learn more

- [What is Azure role-based access control (Azure RBAC)?](https://learn.microsoft.com/azure/role-based-access-control/overview)
- [Azure custom roles](https://learn.microsoft.com/azure/role-based-access-control/custom-roles)
- [Check access for a user to a single Azure resource](https://learn.microsoft.com/azure/role-based-access-control/check-access)
- [Azure built-in roles](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles)
- [Create, invite and delete users](https://learn.microsoft.com/entra/fundamentals/how-to-create-delete-users)
- [Security defaults in Microsoft Entra ID](https://learn.microsoft.com/entra/fundamentals/security-defaults)

Anything you build by hand inside `rg-lab-az104-01-identity` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-01-identity-`.
