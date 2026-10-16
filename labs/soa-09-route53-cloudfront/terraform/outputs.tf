# outputs.tf
#
# Plain English: what the dashboard shows once lab 09 is up (AWS labs spec
# §4, §10): no instances and no peering; the site's address and dig lines
# that ask the lab's zone on its own name server.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "curl -s https://${aws_cloudfront_distribution.site.domain_name}/",
    "dig +short www.${local.zone} @${aws_route53_zone.lab.name_servers[0]}",
    "for i in $(seq 10); do dig +short app.${local.zone} @${aws_route53_zone.lab.name_servers[0]} | head -1; done",
    "aws s3 rm s3://${aws_s3_bucket.site.bucket}/health.html",
  ]
}
