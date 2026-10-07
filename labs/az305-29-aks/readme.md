The smallest Azure Kubernetes Service cluster that does real work: a Free-tier control plane, one small node on Azure CNI Overlay in a subnet of the lab's VNet, and an empty container registry. Deploy a workload with `kubectl`, expose it publicly and privately through the load balancer AKS manages, and run your own image from the lab's registry, pulled with the node's managed identity. From the AZ-305 outline, in Design infrastructure solutions: recommend a container-based solution, and recommend connectivity and load-balancing solutions for it.

## What it deploys

- `aks-lab`, an AKS cluster on the **Free** tier (no control-plane charge, no uptime SLA), with one system node pool, `system`, of a single **Standard_B2s** node (2 vCPU, 4 GiB) with a 64 GiB managed OS disk, no autoscaler and no node image upgrades during the session
- **Azure CNI Overlay**: the node takes an address from `snet-aks`, a /24 of `vnet-lab` (the first /20 of the session's address slot); pods take theirs from AKS's default overlay range, `10.244.0.0/16`, and services from AKS's default `10.0.0.0/16` (DNS at `10.0.0.10`). Neither touches the lab address pool, the gateway's networks or Docker's range, and neither is reachable from outside the cluster except through a service
- Outbound through a **Standard load balancer** that AKS makes, with one outbound public IP (`outbound_type` loadBalancer)
- The **node resource group**, `rg-lab-az305-29-aks-nodes`: Azure makes it and everything in it (the node scale set, the `kubernetes` load balancer and its public IPs, an NSG and the kubelet's managed identity). It is named inside the lab so tear-down and the leftover checks see it; deleting the cluster deletes it
- `id-<prefix>-aks`, the control plane's user-assigned identity, with **Network Contributor** on `snet-aks` only, so it can join the subnet and put internal load balancers in it
- `<prefix>acr`, a Basic container registry with the admin user off, empty, and **attached**: the kubelet identity (`aks-lab-agentpool`, in the node resource group) has **AcrPull** on this registry only, so the node pulls from it with no password or pull secret

```text
rg-lab-az305-29-aks
  vnet-lab (slot /20)
    snet-aks (/24)
      aks-lab (Free tier, Kubernetes default version)
        system pool: 1 x Standard_B2s   pods 10.244.0.0/16 (overlay), services 10.0.0.0/16
        identity id-<prefix>-aks --Network Contributor--> snet-aks
  <prefix>acr (Basic, empty) <--AcrPull-- kubelet identity (node group)
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
rg-lab-az305-29-aks-nodes (made by AKS)
  node scale set, load balancer "kubernetes" + outbound public IP, NSG, kubelet identity
```

Run the Connect lines from Cloud Shell (it has `kubectl`) or your own machine (`az aks install-cli` installs it): `az aks get-credentials` writes a kubeconfig for the cluster's public API server. Deploy with **Peer to gateway** to reach the node and internal load balancers from a tunnel client.

Deploying takes about 12 minutes, most of it the cluster and its node. Tear-down takes about 10.

Cost: about 8p an hour, most of it the node and its disk; the registry is billed by the day. Each LoadBalancer service you add takes one more public IP, a fraction of a penny an hour.

## Things to try

- Look at the networking from both sides: `kubectl get nodes -o wide` (the node's address is in `snet-aks`), `kubectl get pods -A -o wide` (pod addresses from `10.244.0.0/16`) and `kubectl get svc -A` (service addresses from `10.0.0.0/16`). Then open `rg-lab-az305-29-aks-nodes` in the portal and find the scale set behind the node and the NIC that has only the node's address.
- Run and expose a workload: `kubectl create deployment hello --image=mcr.microsoft.com/k8se/quickstart:latest --port=80`, then `kubectl expose deployment hello --type=LoadBalancer --port=80` and `kubectl get svc hello -w` until it has an external IP. Open it in a browser, and find the new frontend IP and rule on the `kubernetes` load balancer in the node resource group.
- Expose the same deployment privately: `kubectl expose deployment hello --name=hello-internal --type=LoadBalancer --port=80 --overrides='{"metadata":{"annotations":{"service.beta.kubernetes.io/azure-load-balancer-internal":"true"}}}'`. AKS makes a second, internal load balancer with an address in `snet-aks` (the control plane's Network Contributor role is what lets it); `curl` that address from a tunnel client while peered.
- Run your own image from the registry: `az acr import -n <prefix>acr --source mcr.microsoft.com/k8se/quickstart:latest --image hello:v1`, then `kubectl create deployment from-acr --image=<prefix>acr.azurecr.io/hello:v1 --port=80` and watch `kubectl get pods -w` until it runs. `kubectl describe pod` shows the pull from your registry: the kubelet identity's **AcrPull** made it, with no pull secret. Check the path with `az aks check-acr --resource-group rg-lab-az305-29-aks --name aks-lab --acr <prefix>acr.azurecr.io`, and find the role on the registry's **Access control (IAM)** blade.
- Scale: `az aks scale --resource-group rg-lab-az305-29-aks --name aks-lab --node-count 2` and see a second node join with its own /24 of pod addresses, then turn on the cluster autoscaler instead with `az aks update ... --enable-cluster-autoscaler --min-count 1 --max-count 2`. A second B2s doubles the node cost, and the B-series quota is 10 vCPUs per region.
- Read the cluster's **Networking** and **Cluster configuration** blades and compare with what the exam asks you to choose: Free against Standard tier (an uptime SLA), overlay against flat pod addressing, a load balancer against a NAT gateway for outbound, a public against a private API server.

## Not built here

**Managed ingress.** The application routing add-on (managed NGINX) is the quick way to an ingress controller on AKS, but Microsoft supports its NGINX resources only until November 2026 and points new work at the Gateway API instead, so this lab exposes services through the load balancer. See [Application routing with the Gateway API](https://learn.microsoft.com/azure/aks/app-routing-gateway-api). **Microsoft Entra ID sign-in and Azure RBAC for Kubernetes** need `kubelogin` and roles the lab's allow-list does not hold, so the cluster keeps local accounts; see [Use Azure RBAC for Kubernetes authorization](https://learn.microsoft.com/azure/aks/manage-azure-rbac). A **private cluster** would need DNS from the tunnel to its private API server zone; see [Create a private AKS cluster](https://learn.microsoft.com/azure/aks/private-clusters).

## Learn more

- [What is Azure Kubernetes Service (AKS)?](https://learn.microsoft.com/azure/aks/what-is-aks)
- [Azure CNI Overlay networking in AKS](https://learn.microsoft.com/azure/aks/concepts-network-azure-cni-overlay)
- [Free, Standard and Premium pricing tiers for AKS cluster management](https://learn.microsoft.com/azure/aks/free-standard-pricing-tiers)
- [Managed identities in AKS](https://learn.microsoft.com/azure/aks/managed-identity-overview)
- [Authenticate with Azure Container Registry from AKS](https://learn.microsoft.com/azure/aks/cluster-container-registry-integration)
- [Customize cluster egress with outbound types in AKS](https://learn.microsoft.com/azure/aks/egress-outboundtype)
- [Use an internal load balancer with AKS](https://learn.microsoft.com/azure/aks/internal-lb)
- [Limits, SKUs and regions in AKS](https://learn.microsoft.com/azure/aks/quotas-skus-regions)

Anything you build by hand inside `rg-lab-az305-29-aks` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az305-29-aks-`.
