## What it deploys

- A storage account with a private container and a stored access policy
- A small VNet with a private endpoint and the `privatelink.blob.core.windows.net` zone
- A group, `lab-<id>-readers`, with Storage Blob Data Reader

```text
rg-lab-<id>
  vnet (slot /20) -- private endpoint -- storage (private container)
  privatelink.blob.core.windows.net
```

## Things to try

- Make a SAS from the stored access policy, then revoke it
- Read a blob as a member of the readers group
- Resolve the storage account's name over the tunnel while peered

## Learn more

- [Grant limited access with SAS](https://learn.microsoft.com/azure/storage/common/storage-sas-overview)

This readme is a stub; the lab's author (plan area L6) writes the full one.

Anything you build by hand inside `rg-lab-az104-06-blob-security` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-06-blob-security-`.
