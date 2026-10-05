Two policy assignments on the lab's resource group, a storage account with a delete lock, and a resource that is already
out of compliance. Practise how a deny policy refuses a change, how the compliance view reports what already exists, and
how locks stop even an Owner. From the AZ-104 outline: implement and manage Azure Policy, configure resource locks, and
apply and manage tags on resources.

## What it deploys

- A custom policy definition, `lab-az104-02-policy-require-costcentre-tag`, that refuses new resources without a
  `costcentre` tag. Its effect is a parameter: Deny, Audit or Disabled
- Two assignments on `rg-lab-az104-02-policy`: that policy with effect Deny (`lab-az104-02-policy-require-tag`), and the
  built-in **Allowed locations** policy permitting only the session's region (`lab-az104-02-policy-allowed-locations`).
  Each has a custom non-compliance message
- `nsg-untagged`, a free network security group made before the deny existed, so it shows as non-compliant
- A storage account (Standard LRS, hot, empty) tagged `costcentre = cc-1234`, with a CanNotDelete lock,
  `lab-az104-02-policy-no-delete`

```text
subscription
  definition: lab-az104-02-policy-require-costcentre-tag
rg-lab-az104-02-policy
  assignment: ...-require-tag ......... Deny: no costcentre tag
  assignment: ...-allowed-locations ... Deny: outside the session's region
  nsg-untagged ........................ made first: non-compliant
  <prefix>tags (storage account) ...... costcentre = cc-1234
    └─ lock: ...-no-delete (CanNotDelete)
```

Cost: pennies at most. Policy, locks and an empty network security group are free; an empty storage account costs next to
nothing.

## Things to try

- Open **Policy**, then **Compliance**, and find the require-tag assignment: `nsg-untagged` is non-compliant. A new
  assignment can take up to about 30 minutes to evaluate; start a scan with
  `az policy state trigger-scan --resource-group rg-lab-az104-02-policy`
- Create a network security group in the lab's group without tags and read the refusal and its custom message. Add a
  `costcentre` tag and try again, then try a different region and see Allowed locations refuse it
- Edit the require-tag assignment's parameters, set the effect to Audit, and create an untagged resource: it now succeeds
  and shows as non-compliant instead
- Try to delete the storage account: the lock refuses. Change the lock to ReadOnly and try **Access keys** or the storage
  browser: a ReadOnly lock blocks more than you might expect, because listing keys is a write-style call
- Tag the resource group itself with `costcentre`. Resources do not inherit it; assign the built-in **Inherit a tag from
  the resource group if missing** policy here and run a remediation task to copy it down

## Learn more

- [What is Azure Policy?](https://learn.microsoft.com/azure/governance/policy/overview)
- [Get compliance data of Azure resources](https://learn.microsoft.com/azure/governance/policy/how-to/get-compliance-data)
- [Tutorial: Manage tag governance with Azure Policy](https://learn.microsoft.com/azure/governance/policy/tutorials/govern-tags)
- [Lock your resources to protect your infrastructure](https://learn.microsoft.com/azure/azure-resource-manager/management/lock-resources)
- [Use tags to organize your Azure resources](https://learn.microsoft.com/azure/azure-resource-manager/management/tag-resources)

Anything you build by hand inside `rg-lab-az104-02-policy` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-02-policy-`.
