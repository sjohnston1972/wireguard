A Bicep file, built to an ARM template and deployed into the lab's resource group. Practise reading a template and its
parameters, previewing a change, redeploying with new values and exporting what you built. From the AZ-104 outline:
interpret an Azure Resource Manager template or a Bicep file, modify an existing ARM template or Bicep file, deploy
resources by using an ARM template or a Bicep file, and export a deployment as an ARM template or convert one to Bicep.

## What it deploys

- One deployment, `bicep-main`, of `main.json`: the ARM template the pipeline builds from this lab's `main.bicep` and its module `vnet.bicep` (in the repo, under `labs/az104-12-bicep/terraform/`) with a pinned Bicep, and Terraform deploys in **Incremental** mode
- From the template: a storage account, `<prefix>bicep` (StorageV2, LRS, TLS 1.2, no public blob access), and `nsg-bicep`, an NSG that allows HTTPS within the VNet
- From the module (a nested deployment, `vnet`): `vnet-bicep`, whose address space is the `vnetCidr` parameter (the first /20 of the session's address slot), with `snet-web` and `snet-app`, a /24 each, both using `nsg-bicep`
- Parameters: `vnetCidr`, `namePrefix` and `tags` from the pipeline; `location` (the group's region) and `accessTier` (`Hot` or `Cool`) take defaults. Outputs: the storage account name, the VNet id and the subnet prefixes

Nothing here has an address to reach, so the lab does not peer. Work in the portal or Cloud Shell.

```text
main.bicep --(pinned bicep build)--> main.json --(Terraform)--> deployment bicep-main (Incremental)
rg-lab-<id>
  <prefix>bicep (storage account, StorageV2 LRS)
  nsg-bicep (allow 443 within the VNet)
  deployment vnet (the module, nested)
    vnet-bicep (vnetCidr = slot /20)
      snet-web (/24) -- nsg-bicep
      snet-app (/24) -- nsg-bicep
```

## Things to try

- Open the group's **Deployments** blade: see `bicep-main` and its nested `vnet`, their inputs, outputs and the template itself. Compare the JSON with `main.bicep` in the repo: which Bicep lines became which JSON, and what the module turned into.
- Download the template from the deployment, then run a what-if in Cloud Shell before changing anything: `az deployment group what-if -g rg-lab-az104-12-bicep --template-file main.json --parameters vnetCidr=<the VNet's range> namePrefix=<prefix> accessTier=Cool`. Read what it would change.
- Redeploy with that changed parameter (`az deployment group create` with the same arguments, and a new `--name`) and watch the storage account's access tier change in place, then see that Incremental mode left everything else alone.
- Export a template from the resource group (**Export template**), compare it with the one you deployed, and convert it to Bicep with `az bicep decompile --file template.json`.
- Add a third subnet by hand in the portal, then redeploy the original template: see what Incremental mode does to a subnet the template does not list, and why the template is the place to make changes.

## Learn more

- [What is Bicep?](https://learn.microsoft.com/azure/azure-resource-manager/bicep/overview)
- [Bicep modules](https://learn.microsoft.com/azure/azure-resource-manager/bicep/modules)
- [Parameters in Bicep](https://learn.microsoft.com/azure/azure-resource-manager/bicep/parameters)
- [Understand the structure and syntax of ARM templates](https://learn.microsoft.com/azure/azure-resource-manager/templates/syntax)
- [Bicep deployment what-if operation](https://learn.microsoft.com/azure/azure-resource-manager/bicep/deploy-what-if)
- [Azure Resource Manager deployment modes](https://learn.microsoft.com/azure/azure-resource-manager/templates/deployment-modes)
- [Decompile ARM template JSON to Bicep](https://learn.microsoft.com/azure/azure-resource-manager/bicep/decompile)

Anything you build by hand inside `rg-lab-az104-12-bicep` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-12-bicep-`.
