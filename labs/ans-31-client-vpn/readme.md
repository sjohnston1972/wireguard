AWS Client VPN is AWS's managed remote-access VPN: you run an OpenVPN-based client on your PC, prove who you are, and reach a VPC as if you were inside it. This lab builds one with mutual certificate authentication, the kind with no directory behind it: a certificate authority made by Terraform signs one certificate for the VPN and one for you, and the dashboard hands you a ready-made profile to download. cloudlabs reaches its labs through its own WireGuard server, so this is also a side-by-side comparison of the two. Everything is listed in the lab's resource group, `lab-ans-31-client-vpn`, in AWS Resource Groups (London); the endpoint is under VPC, Client VPN endpoints in the console.
From the ANS-C01 outline: implement remote access to VPCs with AWS Client VPN, with certificate authentication, authorisation rules and split tunnel.

## What it deploys

- The Client VPN endpoint `cvpn-lab` (description `lab-ans-31-client-vpn`): OpenVPN on UDP 443, mutual certificate authentication, split tunnel, clients given addresses from the last /22 of the lab's slot, sessions of at most 8 hours, connection logging off
- One target network association, `snet-private-1` in `vpc-lab` (it adds the route to `vpc-lab`'s range), and one authorisation rule letting every connected client reach `vpc-lab`
- The certificates: a CA ("cloudlabs ans-31 CA"), a server certificate imported to ACM as `cert-cvpn-server` (with the CA as its chain, so Client VPN trusts client certificates from the same CA), and your client certificate, all valid for 48 hours
- `vm-target` (t4g.nano, a page naming itself), which admits SSH, HTTP and ping from the VPN
- Under **Show**, three files to download: `ans-31.ovpn` (a complete profile with the CA, your certificate and key inside), `client.crt` and `client.key`

The endpoint takes about 10 minutes to become available: associating the subnet is the slow part.

```text
lab-ans-31-client-vpn (London)
  your PC (AWS VPN Client or OpenVPN, ans-31.ovpn) --UDP 443, certificates--> cvpn-lab --> snet-private-1 --> vm-target (vpc-lab)
  split tunnel: only vpc-lab's range goes through the VPN; the rest of your traffic stays on your own connection
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Connect: under **Show**, download `ans-31.ovpn`, import it into the AWS VPN Client (or OpenVPN GUI) and connect. Run the lab unpeered, or disconnect WireGuard first, so only one VPN carries the lab's range. Then `ssh labadmin@<vm-target>` (the session password) and open `http://<vm-target>` in your browser.
- Split tunnel: while connected, run `route print` (Windows) or `ip route` (Linux): only `vpc-lab`'s range points at the VPN; your internet traffic does not. WireGuard does the same with the server's `AllowedIPs` list in your profile.
- Who vm-target sees: on `vm-target` run `ss -tn state established '( sport = :22 )'`. Your SSH session comes from an address in `snet-private-1`, the endpoint's own interface, not from your client address in the /22: Client VPN hands your traffic on from its own addresses, which is why `sg-target` admits `sg-cvpn` rather than the client range.
- In the VPC console, Client VPN endpoints, `cvpn-lab`: the Connections tab shows your connection (each one bills by the hour). Revoke the authorisation rule (Authorization rules tab) and watch SSH stop while you stay connected; authorise `vpc-lab`'s range again for all users to put it back.
- Look at your certificate: `openssl x509 -in client.crt -noout -subject -issuer -dates -ext extendedKeyUsage`. It is signed by the lab's CA, valid for 48 hours, for client authentication only. Compare: WireGuard has no certificates or CA, only a key pair per peer that the server lists by its public key, and it bills nothing per connection; Client VPN bills per association-hour and per connection-hour, but needs no server of your own.

## Not built here

- **AWS Verified Access**: access to applications (not networks) without a VPN, each request checked against identity and device trust. It needs an identity provider or a device-trust provider this lab does not have.

## Learn more

- [What is AWS Client VPN?](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/what-is.html)
- [Mutual authentication in AWS Client VPN](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/mutual.html)
- [Split-tunnel on AWS Client VPN endpoints](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/split-tunnel-vpn.html)
- [AWS Client VPN authorization rules](https://docs.aws.amazon.com/vpn/latest/clientvpn-admin/cvpn-working-rules.html)
- [Import certificates into AWS Certificate Manager](https://docs.aws.amazon.com/acm/latest/userguide/import-certificate.html)
- [What is AWS Verified Access?](https://docs.aws.amazon.com/verified-access/latest/ug/what-is-verified-access.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-31-client-vpn` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
