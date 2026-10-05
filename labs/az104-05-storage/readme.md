Two storage accounts side by side, one locally redundant and Hot, one geo-redundant and Cool, with a blob and a lifecycle
rule, so you can compare redundancy options, move data between access tiers and read how lifecycle management automates
it. From the AZ-104 outline: create and configure storage accounts, configure Azure Storage redundancy, and configure
storage tiers and blob lifecycle management.

## What it deploys

- A storage account ending `hot`: StorageV2, locally redundant (LRS) and the Hot access tier
- A storage account ending `cool`: StorageV2, geo-redundant (GRS) and the Cool access tier
- A private container, `samples`, in the hot account, with one small blob, `hello.txt`
- A lifecycle management rule on the hot account: block blobs move to Cool 30 days after their last change and are deleted after 365

Both account names start with the session's random prefix; the Connect lines show them. There is no network and nothing to peer: you work in the portal, Cloud Shell or Storage Explorer. The cost is a fraction of a penny an hour.

GRS copies the cool account to the session region's paired region (UK South's is UK West). A few newer regions have no pair and cannot hold a GRS account, so the deploy fails there: deploy this lab in a region with a pair.

```text
rg-lab-<id>
  <prefix>hot    LRS, Hot     container samples: hello.txt
                              lifecycle: Cool at 30 days, delete at 365
  <prefix>cool   GRS, Cool    (primary region + paired secondary region)
```

## Things to try

- Open both accounts' **Redundancy** pages and compare them: the GRS account shows a secondary region and the LRS one does not. Change the hot account to GRS, then to RA-GRS, and watch a secondary endpoint appear under **Endpoints**.
- Change `hello.txt` to the Cool tier, then to Archive. Try to download it while it is archived, then start a rehydration back to Hot and read the priority options (standard can take hours, so check back later or just read the status).
- Open **Lifecycle management** on the hot account and read the rule in both the list view and the code view. Add a rule of your own that moves blobs under a prefix to Archive after 90 days. Rules run about once a day, so you will not see one act during a session.
- Upload a file to the cool account and look at its tier: it inherits the account's default (Cool, shown as inferred). Upload another with the tier set explicitly to Hot or Cold and compare.
- In Cloud Shell, run `az storage account show` on each account and compare `sku.name`, `accessTier` and `secondaryLocation`.

## Learn more

- [Storage account overview](https://learn.microsoft.com/azure/storage/common/storage-account-overview)
- [Azure Storage redundancy](https://learn.microsoft.com/azure/storage/common/storage-redundancy)
- [Change how a storage account is replicated](https://learn.microsoft.com/azure/storage/common/redundancy-migration)
- [Access tiers for blob data](https://learn.microsoft.com/azure/storage/blobs/access-tiers-overview)
- [Rehydrate an archived blob to an online tier](https://learn.microsoft.com/azure/storage/blobs/archive-rehydrate-overview)
- [Lifecycle management overview](https://learn.microsoft.com/azure/storage/blobs/lifecycle-management-overview)

Anything you build by hand inside `rg-lab-az104-05-storage` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-05-storage-`.
