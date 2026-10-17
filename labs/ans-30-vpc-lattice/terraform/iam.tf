# iam.tf
#
# Plain English: lab 30's client role, lab-<id>-client, under the lab
# boundary, which vm-client runs as. Its one permission is to invoke VPC
# Lattice services in this account and Region (vpc-lattice-svcs:Invoke);
# the auth policies in lattice.tf then decide which services it may really
# call. The policy is known at plan (ruling A42), so it names the Region's
# services by pattern rather than by their ids, which exist only after
# apply.

resource "aws_iam_role" "client" {
  name                 = "lab-${var.lab_id}-client"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "invoke" {
  name = "lab-${var.lab_id}-invoke"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeLatticeServices"
      Effect   = "Allow"
      Action   = "vpc-lattice-svcs:Invoke"
      Resource = "arn:aws:vpc-lattice:${var.region}:${data.aws_caller_identity.current.account_id}:service/*"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "client" {
  role       = aws_iam_role.client.name
  policy_arn = aws_iam_policy.invoke.arn
}

resource "aws_iam_instance_profile" "client" {
  name = "lab-${var.lab_id}-client"
  path = "/cloudlabs-lab/"
  role = aws_iam_role.client.name
}
