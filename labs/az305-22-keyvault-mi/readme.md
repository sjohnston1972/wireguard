Secrets without passwords: a Key Vault using Azure RBAC, and a VM whose two managed identities may read different things from it. Fetch a token from the instance metadata service and read a secret with no credential stored anywhere. From the AZ-305 outline: design authentication and authorization solutions (authorizing access to Azure resources, and managing secrets, certificates and keys).

## What it deploys

- A Key Vault, `<prefix>kv` (Standard, **Azure RBAC** for data access, public endpoint on, 7 days' soft-delete retention, no purge protection), holding two secrets made from random passwords: `app-db-password` and `reports-api-key`
- A Standard_B1s Ubuntu 24.04 VM, `vm-app`, with no public IP and **two managed identities**: its own system-assigned identity, and a user-assigned identity, `id-<prefix>-app`, that could equally be attached to other VMs
- **Key Vault Secrets User** for the VM's system-assigned identity at the vault (every secret), and for `id-<prefix>-app` at the `reports-api-key` secret only
- **Key Vault Secrets Officer** at the vault for the pipeline's own identity, which writes the secrets; the secrets wait two minutes after that assignment, for the role to reach the vault
- A small VNet, `vnet-lab` (the first /20 of the session's address slot), with `snet-vms`, whose **default outbound access** is on: that is how the VM reaches the vault's public endpoint

```text
rg-lab-az305-22-keyvault-mi
  vnet-lab (slot /20)
    snet-vms (/24, default outbound access on)
      vm-app (B1s, no public IP)
        system-assigned identity --Secrets User (vault)---------> <prefix>kv
        id-<prefix>-app ----------Secrets User (one secret)--+       app-db-password
                                                             +-->    reports-api-key
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
```

The VM user is `azureuser`; its password is behind **Show**. Deploy with **Peer to gateway** to reach the VM from a tunnel client, or use the portal's serial console or **Run command**. The Connect lines give the vault's address and the user-assigned identity's client id, which the commands below need.

Microsoft recommends a vault per application per environment, with roles at vault scope; a role on a single secret is for the exceptions, such as a secret shared with another application, which is what `id-<prefix>-app` stands for here.

Cost: about a penny an hour, nearly all of it the VM.

## Things to try

- On the VM, get a token as the system-assigned identity with `TOKEN=$(curl -s -H Metadata:true "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://vault.azure.net" | python3 -c "import sys, json; print(json.load(sys.stdin)['access_token'])")`, then read a secret with `curl -s -H "Authorization: Bearer $TOKEN" "https://<prefix>kv.vault.azure.net/secrets/app-db-password?api-version=7.4"`
- Do the same as `id-<prefix>-app`: add `&client_id=<client id>` to the token request. `reports-api-key` is returned, `app-db-password` is refused (403): its role is at one secret, not the vault. Paste the token into a JWT decoder and compare the `oid` claims of the two identities
- Add a new version of `reports-api-key` in the portal (give yourself **Key Vault Secrets Officer** at the vault first: your own account has no data role) and read it again from the VM as `id-<prefix>-app`. The assignment is on the secret, not a version, so the new value is readable
- Detach `id-<prefix>-app` from the VM under **Identity**, **User assigned**, and see it survive in the resource group with its role assignment: a user-assigned identity has a life of its own, a system-assigned one is deleted with its VM
- Read the vault's **Access configuration** and compare Azure RBAC with the older vault access policy model: access policies grant per vault, never per secret, and anyone who can write the vault can change them. Do not switch the model here: the lab's roles would stop working

## Learn more

- [Provide access to Key Vault keys, certificates, and secrets with Azure role-based access control](https://learn.microsoft.com/azure/key-vault/general/rbac-guide)
- [Azure RBAC vs. access policies](https://learn.microsoft.com/azure/key-vault/general/rbac-access-policy)
- [What are managed identities for Azure resources?](https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/overview)
- [How to use managed identities on an Azure VM to acquire an access token](https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/how-to-use-vm-token)
- [Azure Key Vault soft-delete overview](https://learn.microsoft.com/azure/key-vault/general/soft-delete-overview)
- [Default outbound access in Azure](https://learn.microsoft.com/azure/virtual-network/ip-services/default-outbound-access)

Anything you build by hand inside `rg-lab-az305-22-keyvault-mi` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az305-22-keyvault-mi-`.
