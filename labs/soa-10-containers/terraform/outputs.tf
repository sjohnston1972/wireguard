# outputs.tf
#
# Plain English: what the dashboard shows once lab 10 is up (AWS labs spec
# §4, §10). The tasks come and go, so no fixed addresses: the load balancer's
# address, how to list the tasks, and how to push an image of your own.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "curl -sI http://${aws_lb.web.dns_name}/",
    "aws ecs list-tasks --cluster ${aws_ecs_cluster.lab.name} --service-name ${aws_ecs_service.web.name}",
    "aws ecr get-login-password | docker login --username AWS --password-stdin ${aws_ecr_repository.web.repository_url}",
    "docker pull --platform linux/arm64 public.ecr.aws/nginx/nginx:stable-alpine && docker tag public.ecr.aws/nginx/nginx:stable-alpine ${aws_ecr_repository.web.repository_url}:v1 && docker push ${aws_ecr_repository.web.repository_url}:v1",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
