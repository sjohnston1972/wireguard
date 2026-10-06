An Application Gateway on the WAF_v2 SKU in front of two web VMs: a private HTTPS listener whose certificate the gateway reads from Key Vault, an HTTP to HTTPS redirect, a rewrite set that adds and removes response headers, and a web application firewall policy in Prevention mode with Microsoft's managed rules and a custom rule of its own. From the AZ-700 outline, in Design and implement application delivery services: select an Application Gateway SKU and tier, implement TLS certificates, configure listeners, routing rules, backend settings and health probes, configure rewrite sets and autoscaling. And in Design and implement Azure network security services: implement a WAF policy, configure detection or prevention mode, configure rule sets for Application Gateway, implement custom rules and monitor a WAF.

## What it deploys

- `vnet-hub` (the first /20 of the session's address slot) with `snet-agw`, the gateway's own /24, and `snet-web`, a /24 for the VMs
- `vm-web1` and `vm-web2`: Standard_B1s Ubuntu 24.04 VMs with no public IP that serve their names on port 80 with python3's built-in web server
- `agw-hub`, an Application Gateway **WAF_v2** autoscaling from 0 to 2 instances, with a user-assigned identity, `id-<prefix>-agw`. Azure insists it owns a public IP, `pip-agw`, but nothing listens there: both listeners are on the private frontend (the 10th address of `snet-agw`)
- Listener `listener-http` on port 80, whose rule **redirects** permanently to `listener-https` on port 443 (path and query string kept); `listener-https` terminates TLS with certificate `cert-app` and sends requests to both VMs on port 80, with an HTTP probe on `/`
- A **rewrite set**, `rw-headers`, on the HTTPS rule: every response gets `X-Lab: 41` and loses its `Server` header
- `<prefix>kv`, a Key Vault Standard using **access policies** (no purge protection, 7 days' soft delete, purged at tear-down), holding `cert-app`: a self-signed certificate for `CN=app.lab41.internal`, valid 12 months and renewed by the vault 30 days before it expires. The pipeline's policy lets it make the certificate; the gateway identity's policy lets it get secrets (the certificate with its key) and nothing else. No role assignment is made
- `waf-hub`, a WAF policy in **Prevention** mode with the Microsoft Default Rule Set 2.1 and one custom rule, `BlockAttackQuery`, which blocks any query string containing `attack=1`
- A private DNS zone, `lab41.internal`, with `app` pointing at the private frontend and linked to `vnet-hub`
- `log-agw`, a Log Analytics workspace capped at 0.05 GB a day, receiving the gateway's access and firewall logs in resource-specific tables (`AGWAccessLogs`, `AGWFirewallLogs`)
- `nsg-agw` on `snet-agw`: GatewayManager on TCP 65200-65535 (the gateway will not start without it) and ports 80 and 443 from VirtualNetwork

The gateway takes 5 to 15 minutes to create and about as long to delete. Deploy with **Peer to gateway**: while peered, the pipeline links `lab41.internal` to the gateway VNet, so a tunnel client resolves `app.lab41.internal` through the tunnel's DNS and can browse it (the certificate is self-signed, so expect a warning, or use `curl -k`). The VM user is `azureuser`; its password is behind **Show**.

```text
rg-lab-<id>
  vnet-hub (slot /20)
    snet-agw (/24)  nsg-agw: GatewayManager 65200-65535, 80/443 from VirtualNetwork
      agw-hub (WAF_v2, 0-2)     pip-agw: no listener
        fe-private .10  :80 listener-http  --redirect-->  :443 listener-https (cert-app)
                                                            | rw-headers: +X-Lab, -Server
        firewall policy: waf-hub (Prevention, DRS 2.1, BlockAttackQuery)
        identity id-<prefix>-agw --access policy: get secrets--> <prefix>kv / cert-app
    snet-web (/24)                                          v
      vm-web1 :80   vm-web2 :80   <------------------  pool-web (probe /)
  lab41.internal: app -> fe-private        log-agw <-- access and firewall logs
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- From a tunnel client, `curl -ki https://app.lab41.internal/` several times: see both VMs answer, the `X-Lab: 41` header and no `Server` header. Then `curl -i http://app.lab41.internal/` and follow the 301 to HTTPS.
- Trigger the WAF: `curl -k "https://app.lab41.internal/?id=1'or'1'='1"` (a SQL injection pattern the managed rules catch) and `curl -k "https://app.lab41.internal/?attack=1"` (the custom rule): both get 403. Switch the policy to **Detection** mode, repeat, and find the requests in `AGWFirewallLogs` with KQL instead of being blocked (logs take a few minutes to arrive).
- Add a rewrite rule of your own: a request header the VMs would see, or a condition that only rewrites some paths. Read the order: rule sequence decides which runs first.
- Rotate the certificate: create a new version of `cert-app` in the vault (Certificates, New version) and watch the gateway pick it up within a few hours, because its listener names the versionless secret. Then read the vault's **Access policies** and compare them with Azure RBAC: why does this lab use policies?
- Stop the web server on `vm-web1` (`sudo systemctl stop lab-http`) and read the gateway's **Backend health**; start it again.

## Not built here

Application Gateway for Containers and the Basic v2 SKU (not registered in this subscription) are the other Application Gateway choices; Front Door's WAF at the edge is in lab 42.

## Learn more

- [What is Azure Application Gateway v2?](https://learn.microsoft.com/azure/application-gateway/overview-v2)
- [TLS termination with Key Vault certificates](https://learn.microsoft.com/azure/application-gateway/key-vault-certs)
- [Rewrite HTTP headers and URL with Application Gateway](https://learn.microsoft.com/azure/application-gateway/rewrite-http-headers-url)
- [Application Gateway redirect overview](https://learn.microsoft.com/azure/application-gateway/redirect-overview)
- [What is Azure Web Application Firewall on Application Gateway?](https://learn.microsoft.com/azure/web-application-firewall/ag/ag-overview)
- [Custom rules for Web Application Firewall v2 on Application Gateway](https://learn.microsoft.com/azure/web-application-firewall/ag/custom-waf-rules-overview)
- [Azure Key Vault access policies](https://learn.microsoft.com/azure/key-vault/general/assign-access-policy)

Anything you build by hand inside `rg-lab-az700-41-appgw-waf` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-41-appgw-waf-`.
