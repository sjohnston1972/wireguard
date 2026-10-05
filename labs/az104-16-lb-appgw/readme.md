Two web VMs behind two kinds of load balancer: an internal Standard load balancer (layer 4) and an Application Gateway
Basic (layer 7) with a private listener. Practise configuring frontends, backend pools, health probes and rules, and
troubleshooting a backend that stops answering. From the AZ-104 outline: configure an internal or public load balancer,
troubleshoot load balancing, and configure public IP addresses.

## What it deploys

- A VNet, `vnet-lab` (the first /20 of the session's address slot), with `snet-web` and, for the gateway alone, `snet-appgw` (each a /24)
- `vm-web1` and `vm-web2`: Standard_B1s Ubuntu 24.04 VMs with no public IP that serve their names on port 80 with python3's built-in web server
- `lbi-web`, an internal Standard load balancer: a fixed private frontend (`fe-web`, the 10th address of `snet-web`), backend pool `pool-web` with both VMs, a TCP probe on port 80 and a rule from 80 to 80. Basic load balancers are retired, so it is Standard
- `agw-web`, an Application Gateway on the Basic SKU, in `snet-appgw`: a private frontend (the 10th address of `snet-appgw`) with the only listener, an HTTP setting on port 80 and a rule to both VMs
- `pip-appgw`, the Standard public IP the gateway must own. Nothing listens on it, so it answers nothing
- `nsg-appgw` on `snet-appgw`: allows **GatewayManager** on TCP 65200-65535 (Azure manages the gateway through these and it will not start without them) and port 80 from **VirtualNetwork**

The gateway takes 5 to 15 minutes to create and about as long to delete, so this lab is slow to deploy and tear down. Deploy with **Peer to gateway** to curl both frontends from a tunnel client (the Connect lines); otherwise use the serial console or Run command on a VM. The VM user is `azureuser`; its password is behind **Show**.

```text
rg-lab-<id>
  vnet-lab (slot /20)
    snet-appgw (/24)  nsg-appgw: GatewayManager 65200-65535, 80 from VirtualNetwork
      agw-web (Basic)  fe-private .10:80 (listener) --+     pip-appgw: no listener
    snet-web (/24)                                    |
      lbi-web (Standard, internal)  fe-web .10:80 ----+--> pool-web
        probe: TCP 80                                      vm-web1 :80
                                                           vm-web2 :80
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- Run `curl http://<lbi-web address>` several times, then the same against the gateway's private frontend, and see which VM answers each time. Then try the public IP: nothing listens there.
- On `vm-web1`, stop the web server with `sudo systemctl stop lab-http`. Watch the load balancer's **Health Probe Status** metric drop and the gateway's **Backend health** turn unhealthy, while every curl now gets `vm-web2`. Start it again.
- Change the load balancer rule's **Session persistence** to **Client IP** and repeat the curls.
- Add a custom health probe to the gateway that asks for `/index.html` and attach it to `http-80`; then ask for a path that does not exist and see the backend marked unhealthy.
- Open `nsg-appgw` and read why the GatewayManager rule is there. Compare the gateway's **Frontend IP configurations** with the load balancer's.

## Learn more

- [What is Azure Load Balancer?](https://learn.microsoft.com/azure/load-balancer/load-balancer-overview)
- [Azure Load Balancer components](https://learn.microsoft.com/azure/load-balancer/components)
- [Azure Load Balancer health probes](https://learn.microsoft.com/azure/load-balancer/load-balancer-custom-probe-overview)
- [What is Azure Application Gateway?](https://learn.microsoft.com/azure/application-gateway/overview)
- [Application Gateway infrastructure configuration](https://learn.microsoft.com/azure/application-gateway/configuration-infrastructure)
- [Troubleshoot backend health issues in Application Gateway](https://learn.microsoft.com/azure/application-gateway/application-gateway-backend-health-troubleshooting)
- [Load-balancing options](https://learn.microsoft.com/azure/architecture/guide/technology-choices/load-balancing-overview)

Anything you build by hand inside `rg-lab-az104-16-lb-appgw` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-16-lb-appgw-`.
