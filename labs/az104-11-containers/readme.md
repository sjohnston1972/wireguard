Containers without a VM: one in Azure Container Instances, one in Azure Container Apps, and a registry to keep images in.
Practise provisioning each, sizing and scaling them, and see how they differ in networking and billing.
From the AZ-104 outline: create and manage an Azure container registry, provision a container by using Azure Container
Instances and by using Azure Container Apps, and manage sizing and scaling for containers.

## What it deploys

- A small VNet, `vnet-lab` (the first /20 of the session's address slot), with `snet-aci`, a subnet delegated to Azure Container Instances
- `aci-hello`, a container group running Microsoft's `aci-helloworld` image with 0.5 vCPU and 0.5 GB, with a private address in `snet-aci` and no public IP
- `cae-lab`, a consumption-only Container Apps environment with no subnet of its own (so Azure makes no extra resource group), and `ca-hello`, an app running the `k8se/quickstart` image with public HTTPS ingress. It scales to **zero** replicas when idle and starts one on the first request
- `<prefix>acr`, a Basic container registry with the admin user off. It is empty: both images come from Microsoft's public registry, MCR

Deploy with **Peer to gateway** to reach `aci-hello` from a tunnel client. The container app's address is public: open its Connect line in a browser.

```text
rg-lab-<id>
  vnet-lab (slot /20)
    snet-aci (/24, delegated to ACI)
      aci-hello (0.5 vCPU, 0.5 GB, private IP) <-- curl over peering <-- you
  cae-lab (Container Apps, consumption only, no subnet)
    ca-hello (0 to 1 replicas) <-- https://ca-hello.<env>.uksouth.azurecontainerapps.io <-- you
  <prefix>acr (Basic, admin user off, empty)
  images from mcr.microsoft.com
```

## Things to try

- Open the container app's address and watch its **Revisions and replicas** blade: the first request starts a replica (a short delay), and a few minutes after the last one it scales back to zero. Look at the app's **Scale** rule and change the maximum.
- Look at `aci-hello`'s **Containers** blade: its logs, events and a **Connect** shell. Then `curl` its private address while peered. Note there is no scaling: a container group runs exactly what you asked for.
- Push an image to the registry from Cloud Shell: `az acr import -n <prefix>acr --source mcr.microsoft.com/k8se/quickstart:latest --image quickstart:v1`, then list it under **Repositories**. Try to pull it anonymously and see why the admin user and role assignments matter.
- Create a new revision of `ca-hello` with a different CPU and memory size (for example 0.5 vCPU and 1Gi) and see which combinations Container Apps allows. Compare with resizing an ACI group, which means recreating it.
- Create a second ACI group by hand with a public IP and a DNS name label, compare the two, and delete it again.

## Learn more

- [What is Azure Container Instances?](https://learn.microsoft.com/azure/container-instances/container-instances-overview)
- [Virtual network scenarios for Azure Container Instances](https://learn.microsoft.com/azure/container-instances/container-instances-virtual-network-concepts)
- [Azure Container Apps overview](https://learn.microsoft.com/azure/container-apps/overview)
- [Set scaling rules in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/scale-app)
- [Azure Container Apps environments](https://learn.microsoft.com/azure/container-apps/environment)
- [Introduction to Azure Container Registry](https://learn.microsoft.com/azure/container-registry/container-registry-intro)
- [Billing in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/billing)

Anything you build by hand inside `rg-lab-az104-11-containers` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-11-containers-`.
