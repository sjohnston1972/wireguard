# docker/home/Dockerfile
#
# Plain English: the home end of site-to-site. A tiny Linux box (Alpine) that
# dials the Azure headend like any client, but also carries the home LAN:
# packets from tunnel clients for 192.168.1.x come out of the tunnel here and
# are NATed onto the home network. Think of a branch router's WAN tunnel with
# "ip nat inside" on the LAN side. It also answers the dashboard's speed test
# (iperf3 server on port 5201, reachable only through the tunnel).
FROM alpine:3.20
RUN apk add --no-cache wireguard-tools iproute2 iptables iperf3 bind-tools tini
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
