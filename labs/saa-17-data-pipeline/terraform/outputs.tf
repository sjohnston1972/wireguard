# outputs.tf
#
# Plain English: what the dashboard shows once lab 17 is up: CloudShell lines
# to watch the stream, list what Firehose wrote, run the crawler, and query
# the table in the lab's workgroup.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "aws kinesis describe-stream-summary --region ${var.region} --stream-name ${aws_kinesis_stream.events.name}",
    "aws s3 ls --recursive s3://${aws_s3_bucket.lake.bucket}/events/ | tail",
    "aws glue start-crawler --region ${var.region} --name ${aws_glue_crawler.events.name}",
    "aws athena start-query-execution --region ${var.region} --work-group ${aws_athena_workgroup.wg.name} --query-string \"SELECT action, count(*) AS n, round(sum(amount), 2) AS total FROM ${local.glue_db}.events GROUP BY action ORDER BY n DESC\"",
  ]
}
