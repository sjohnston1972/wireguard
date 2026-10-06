Two storage accounts designed for two different jobs: a data lake whose raw data ages through the access tiers on its
own, and a records account whose evidence container keeps every blob unchangeable for a day and keeps a readable copy in
the paired region. Practise choosing redundancy, tiers, a hierarchical namespace and immutability for a workload. From
the AZ-305 outline: recommend a solution for storing unstructured data, a data storage solution that balances features,
performance and costs, a data solution for protection and durability, and a high availability solution for unstructured
data.

## What it deploys

- A Data Lake Storage account ending `lake`: StorageV2, locally redundant (LRS), Hot, with the **hierarchical namespace** on, so containers are file systems with real directories and POSIX-style ACLs
- Two file systems in it, `raw` and `curated`, both private
- A lifecycle management policy on the lake: block blobs under `raw/` move to **Cool** 30 days after their last change, **Cold** at 90 and **Archive** at 180; blobs under `curated/` are deleted after 365 days
- A records account ending `rec`: StorageV2, **read-access geo-redundant (RA-GRS)**, Hot, so a read-only copy lives in the paired region (UK South's is UK West) behind its own secondary endpoint
- A private container, `evidence`, in the records account, with a **time-based retention policy of 1 day, unlocked**, and protected append writes: for a day after it is written, no blob in it can be changed or deleted, though append blobs can still grow

Both account names start with the session's random prefix; the Connect lines show them. Terraform never writes through the accounts' data endpoints, so every container starts empty: you upload the first files. There is no SFTP (it is billed by the hour), no public container and no version-level immutability. There is no network and nothing to peer: you work in the portal's Storage browser, Cloud Shell or Storage Explorer. The cost is a fraction of a penny an hour.

The retention policy is **unlocked**, so tear-down can delete it. **Never lock the policy** (the portal's **Lock policy** button): a locked policy cannot be shortened or deleted, and the account could not be deleted until every blob's retention ran out. Tear-down removes any legal hold you add, and the unlocked policy, before it deletes the accounts.

```text
rg-lab-<id>
  <prefix>lake   LRS, Hot, hierarchical namespace (Data Lake Storage)
    raw/       lifecycle: Cool at 30 days, Cold at 90, Archive at 180
    curated/   lifecycle: delete at 365 days
  <prefix>rec    RA-GRS, Hot   (primary region + read-only copy in its pair)
    evidence   time-based retention 1 day, UNLOCKED, append writes allowed
```

## Things to try

- Upload a file to `evidence`, then try to overwrite it and to delete it: both are refused while its day of retention runs. Delete the container's contents a day later, or let tear-down remove the policy and the account.
- On `evidence`, open **Access policy** and add a **legal hold** with a tag such as `case42`: blobs are now held until the hold is cleared, whatever the retention says. Clear it again (tear-down removes a legal hold you leave behind too). Read why a lab never uses **Lock policy**.
- In Storage browser, open `raw` on the lake account: create directories, upload a file into one, then open **Manage ACL** and grant a user read and execute on a directory. Compare renaming a directory here (one operation) with renaming a "folder" in the records account (a copy of every blob).
- Upload a small file to `raw`, change its tier to **Cold**, then **Archive**. Try to download it, then read the **rehydrate** options (standard or high priority, by copy or by changing the tier) and their costs; a standard rehydration can take hours, so just start it and read the status.
- Open the records account's **Endpoints** and find the **secondary endpoint** (`-secondary` in the host name). Upload a blob and read it from the secondary endpoint with a SAS token once it has replicated; then open **Redundancy** and read the last sync time and what a customer-managed failover would do.
- Open the lake's **Lifecycle management** in code view and add a rule that moves `curated/` to Cool after 30 days without access (it needs **last access time tracking** on). Rules run about once a day, so none acts during a session.

## Learn more

- [Introduction to Azure Data Lake Storage](https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction)
- [Azure Data Lake Storage hierarchical namespace](https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-namespace)
- [Store business-critical blob data with immutable storage in a write once, read many (WORM) state](https://learn.microsoft.com/azure/storage/blobs/immutable-storage-overview)
- [Time-based retention policies for immutable blob data](https://learn.microsoft.com/azure/storage/blobs/immutable-time-based-retention-policy-overview)
- [Legal holds for immutable blob data](https://learn.microsoft.com/azure/storage/blobs/immutable-legal-hold-overview)
- [Access tiers for blob data](https://learn.microsoft.com/azure/storage/blobs/access-tiers-overview)
- [Lifecycle management overview](https://learn.microsoft.com/azure/storage/blobs/lifecycle-management-overview)
- [Azure Storage redundancy](https://learn.microsoft.com/azure/storage/common/storage-redundancy)

Anything you build by hand inside `rg-lab-az305-25-storage-design` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az305-25-storage-design-`.
