## What it deploys

- A storage account ending `blob` (StorageV2, LRS, Hot) with an empty private container, `private`. Shared-key access and public network access start on.
- A small VNet, `vnet-lab` (the first /20 of the session's address slot), with a subnet `snet-endpoints`
- A private endpoint for the account's blob service in `snet-endpoints`
- The private DNS zone `privatelink.blob.core.windows.net`, linked to `vnet-lab`, holding the endpoint's address
- An Entra group, `lab-az104-06-blob-security-readers`, with **Storage Blob Data Reader** on the lab's resource group. It starts with no members.

When you deploy with **Peer to gateway**, the pipeline peers `vnet-lab` with the gateway's VNet and also links the private DNS zone to it, so tunnel clients that use the tunnel's DNS resolve the account to its private address. The Connect lines show the account's name.

```text
rg-lab-<id>
  vnet-lab (slot /20)                               privatelink.blob.core.windows.net
    snet-endpoints (/24)                              A <prefix>blob -> endpoint address
      private endpoint --(blob)--> <prefix>blob     linked to vnet-lab (and the gateway VNet while peered)
                                     container: private (empty)
  Entra group lab-<id>-readers: Storage Blob Data Reader on rg-lab-<id>
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- Upload a small file to `private` from the portal (it uses the account key). On the blob, **Generate SAS** with Read only for one hour and open the URL in a private browser window. Then rotate the key that signed it under **Access keys** and watch the same URL stop working.
- Add a **stored access policy** to the container (**Access policy**, for example `read-1h` with Read), then make a SAS that uses it, for example with `az storage blob generate-sas --policy-name read-1h`. Delete or shorten the policy and the SAS stops working without rotating any key (allow about 30 seconds).
- Open the container with **Authentication method: Microsoft Entra user account**. Owner on the subscription is not enough to read blob data. Add yourself to the `lab-az104-06-blob-security-readers` group, wait a few minutes, and try again; uploads are still refused. Then make a user delegation SAS with `az storage blob generate-sas --as-user --auth-mode login`.
- Peer the lab, then from a tunnel client run the `nslookup` Connect line: the name resolves through `privatelink.blob.core.windows.net` to the endpoint's private address. Unpeered, or from outside the tunnel, it resolves to a public address.
- Under **Networking**, set public network access to **Disabled**. The portal at home can no longer list the container, but a peered tunnel client can still fetch your SAS URL over the private endpoint. Tear-down works either way.
- Open the private endpoint's network interface and its **DNS configuration**, then find the matching A record in the private DNS zone.

## Learn more

- [Grant limited access with shared access signatures](https://learn.microsoft.com/azure/storage/common/storage-sas-overview)
- [Define a stored access policy](https://learn.microsoft.com/rest/api/storageservices/define-stored-access-policy)
- [Create a user delegation SAS with the Azure CLI](https://learn.microsoft.com/azure/storage/blobs/storage-blob-user-delegation-sas-create-cli)
- [Assign an Azure role for access to blob data](https://learn.microsoft.com/azure/storage/blobs/assign-azure-role-data-access)
- [Use private endpoints for Azure Storage](https://learn.microsoft.com/azure/storage/common/storage-private-endpoints)
- [Azure private endpoint DNS configuration](https://learn.microsoft.com/azure/private-link/private-endpoint-dns)

Anything you build by hand inside `rg-lab-az104-06-blob-security` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-06-blob-security-`.
