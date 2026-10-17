# iam.tf
#
# Plain English: lab 24's consumer role, lab-<id>-consumer, under the lab
# boundary: vm-consumer may list and read the lab's bucket and nothing else
# in S3. The policy names the bucket by its built ARN, so it is known at plan
# (ruling A42).

resource "aws_iam_role" "consumer" {
  name                 = "lab-${var.lab_id}-consumer"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "s3_read" {
  name = "lab-${var.lab_id}-s3-read"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabBucketList", Effect = "Allow", Action = "s3:ListBucket", Resource = local.data_arn },
      { Sid = "LabBucketRead", Effect = "Allow", Action = "s3:GetObject", Resource = "${local.data_arn}/*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "consumer" {
  role       = aws_iam_role.consumer.name
  policy_arn = aws_iam_policy.s3_read.arn
}

resource "aws_iam_instance_profile" "consumer" {
  name = "lab-${var.lab_id}-consumer"
  path = "/cloudlabs-lab/"
  role = aws_iam_role.consumer.name
}
