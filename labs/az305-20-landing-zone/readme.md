A landing zone in miniature: a management group tree shaped like the Cloud Adoption Framework's, a policy initiative and a deny assigned where they belong, and two least-privilege custom roles assigned to the identities they were designed for. From the AZ-305 outline: design governance (a structure for management groups, subscriptions and resource groups, a tagging strategy, managing compliance) and design authorization (authorizing access to Azure resources).

## What it deploys

- Six management groups under the tenant root group: `lab-az305-20-landing-zone-root`, with `-platform`, `-landingzones` and `-sandbox` under it, and `-corp` and `-online` under `-landingzones`
- A custom policy definition stored at the root group, `lab-az305-20-landing-zone-audit-costcentre`, that reports resources without a `costcentre` tag (audit only)
- An initiative (policy set) stored at the root group, `lab-az305-20-landing-zone-baseline`, with two definition groups: **Location** (built-in Allowed locations, the session's region only) and **Tagging** (built-in Require a tag on resource groups, `costcentre`, and the custom audit)
- The initiative assigned at `-landingzones` as `lz-baseline`, so `-corp` and `-online` inherit it, and the built-in Not allowed resource types assigned at `-sandbox` as `sandbox-no-pip`, refusing public IP addresses (names at management group scope are limited to 24 characters, so the lab's prefix is in the display names)
- Two custom roles defined at the subscription but assignable only at `rg-lab-az305-20-landing-zone`: `lab-az305-20-landing-zone-netops` (read the network, change NSG rules and routes) and `lab-az305-20-landing-zone-appops` (see VMs and their metrics, start, restart and deallocate them)
- Two user-assigned managed identities in `rg-lab-az305-20-landing-zone`, `id-<prefix>-netops` and `id-<prefix>-appops`, each holding its role at the resource group: the persona the role was designed for

```text
Tenant root group
  ├─ (your subscription stays where it is)
  └─ lab-az305-20-landing-zone-root ...... initiative and audit stored here
       ├─ -platform
       ├─ -landingzones .................. lz-baseline (initiative) assigned here
       │    ├─ -corp ..................... inherits it
       │    └─ -online ................... inherits it
       └─ -sandbox ....................... sandbox-no-pip (deny public IPs)

rg-lab-az305-20-landing-zone
  id-<prefix>-netops <-- lab-...-netops (custom role, assignable only here)
  id-<prefix>-appops <-- lab-...-appops (custom role, assignable only here)
```

No subscription is inside the tree, so compliance shows nothing evaluated: policy evaluates resources in subscriptions, and the lab never moves one in. Never move the real subscription into the lab's tree: a deny on a parent group reaches everything below it, including the gateway. The custom roles are assigned by the lab itself, and only inside its own resource group.

Cost: nothing. Management groups, policy, custom roles, role assignments and managed identities are free.

To see the tree in the portal your account needs read access on it: the pipeline created it. As a Global Administrator you can turn on **Access management for Azure resources** in the Entra admin centre (Properties), which gives you User Access Administrator at the root of the hierarchy. Turn it off again when you finish.

## Things to try

- Open **Policy**, then **Definitions**, and find `lab-az305-20-landing-zone-baseline`: read its groups, its three definitions and the parameter values each is given. Then open **Assignments** at `-corp` and see `lz-baseline` inherited from `-landingzones`
- Open **Compliance** at `-landingzones`: nothing is evaluated, because no subscription is inside. Sketch where a real platform subscription (connectivity, identity, management) and workload subscriptions would sit in this tree, and which of them `sandbox-no-pip` would reach
- Add a policy exemption at `-corp` for `lz-baseline` (category **Waiver**, an expiry date tomorrow) and read how it differs from an exclusion on the assignment. Delete it when you finish: tear-down removes what the lab made, and an exemption you add is not one of those
- Open the two custom roles under the resource group's **Access control (IAM)**, **Roles**, and compare their actions with the built-in Network Contributor and Virtual Machine Contributor. Read why each is assignable only at `rg-lab-az305-20-landing-zone`
- Assign `lab-az305-20-landing-zone-netops` to yourself at `rg-lab-az305-20-landing-zone`, sign in again, and try to create an NSG (refused) and then a rule on one you are given (allowed). Remove the assignment afterwards
- Under the resource group's **Access control (IAM)**, **Role assignments**, find each managed identity and its one role: identities as personas, with no password to rotate

## Learn more

- [What is an Azure landing zone?](https://learn.microsoft.com/azure/cloud-adoption-framework/ready/landing-zone/)
- [Management groups in an Azure landing zone](https://learn.microsoft.com/azure/cloud-adoption-framework/ready/landing-zone/design-area/resource-org-management-groups)
- [Azure Policy initiative definition structure](https://learn.microsoft.com/azure/governance/policy/concepts/initiative-definition-structure)
- [Azure Policy exemption structure](https://learn.microsoft.com/azure/governance/policy/concepts/exemption-structure)
- [Azure custom roles](https://learn.microsoft.com/azure/role-based-access-control/custom-roles)
- [What are managed identities for Azure resources?](https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/overview)
- [Elevate access to manage all Azure subscriptions and management groups](https://learn.microsoft.com/azure/role-based-access-control/elevate-access-global-admin)

Anything you build by hand inside `rg-lab-az305-20-landing-zone` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az305-20-landing-zone-`.
