# compute.tf
#
# Plain English: lab 15's test instance, vm-client (t4g.nano), running as
# lab-<id>-client under the lab boundary: it may list, read and write the
# lab's bucket, and use the lab's key only through S3 for that bucket
# (kms:ViaService and the encryption context, never the alias, which takes
# minutes to count; ruling A81). It has no other way out than the S3
# endpoint: no NAT gateway.

resource "aws_iam_role" "client" {
  name                 = "lab-${var.lab_id}-client"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "client" {
  name = "lab-${var.lab_id}-client"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabBucket", Effect = "Allow", Action = ["s3:ListBucket", "s3:GetObject", "s3:PutObject"], Resource = [local.bucket_arn, "${local.bucket_arn}/*"] },
      {
        Sid       = "LabKeyThroughS3"
        Effect    = "Allow"
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" }, StringLike = { "kms:EncryptionContext:aws:s3:arn" = [local.bucket_arn, "${local.bucket_arn}/*"] } }
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "client" {
  role       = aws_iam_role.client.name
  policy_arn = aws_iam_policy.client.arn
}

resource "aws_iam_instance_profile" "client" {
  name = "lab-${var.lab_id}-client"
  path = "/cloudlabs-lab/"
  role = aws_iam_role.client.name
}

resource "aws_instance" "client" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  iam_instance_profile   = aws_iam_instance_profile.client.name
  user_data              = local.cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-client" })
  tags        = { Name = "vm-client" }
  depends_on  = [aws_iam_role_policy_attachment.client, aws_vpc_endpoint_policy.s3]
}
