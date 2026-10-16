# outputs.tf
#
# Plain English: what the dashboard shows once lab 19 is up: the CloudShell
# lines to give yourself access (an access entry for your own IAM role or
# user), point kubectl at the cluster, deploy the sample and reach it by
# port-forward. The node comes and goes with its group: no fixed address.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "ARN=$(aws sts get-caller-identity --query Arn --output text) && case $ARN in *:assumed-role/*) R=$${ARN#*:assumed-role/}; ME=$(aws iam get-role --role-name $${R%%/*} --query Role.Arn --output text);; *) ME=$ARN;; esac && aws eks create-access-entry --region ${var.region} --cluster-name ${aws_eks_cluster.lab.name} --principal-arn $ME && aws eks associate-access-policy --region ${var.region} --cluster-name ${aws_eks_cluster.lab.name} --principal-arn $ME --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy --access-scope type=cluster",
    "aws eks update-kubeconfig --region ${var.region} --name ${aws_eks_cluster.lab.name}",
    "kubectl create deployment web --image=public.ecr.aws/nginx/nginx:stable-alpine --replicas=2 && kubectl rollout status deployment/web",
    "kubectl port-forward deployment/web 8080:80 & sleep 3; curl -sI http://localhost:8080/",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
