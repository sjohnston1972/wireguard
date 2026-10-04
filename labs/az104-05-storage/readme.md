## What it deploys

- A storage account, LRS and hot
- A storage account, GRS and cool
- A lifecycle policy: cool at 30 days, delete at 365
- One blob

```text
rg-lab-<id>
  storage LRS hot  (lifecycle policy, one blob)
  storage GRS cool
```

## Things to try

- Compare the two accounts' redundancy settings
- Change the blob's access tier by hand
- Read the lifecycle policy's rules

## Learn more

- [Storage account overview](https://learn.microsoft.com/azure/storage/common/storage-account-overview)

This readme is a stub; the lab's author (plan area L6) writes the full one.

Anything you build by hand inside `rg-lab-az104-05-storage` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-05-storage-`.
