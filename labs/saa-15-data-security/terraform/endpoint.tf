# endpoint.tf
#
# Plain English: a policy on the template's S3 gateway endpoint (ruling P18):
# through it the lab's instances may reach only the lab's own bucket and
# Amazon Linux's package repositories. Any other bucket, even a public one,
# is refused at the endpoint, whatever the instance's role allows.

resource "aws_vpc_endpoint_policy" "s3" {
  vpc_endpoint_id = aws_vpc_endpoint.s3.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabBucketOnly", Effect = "Allow", Principal = "*", Action = "s3:*", Resource = [local.bucket_arn, "${local.bucket_arn}/*"] },
      { Sid = "AmazonLinuxRepositories", Effect = "Allow", Principal = "*", Action = "s3:GetObject", Resource = "arn:aws:s3:::al2023-repos-${var.region}-*/*" },
    ]
  })
}
