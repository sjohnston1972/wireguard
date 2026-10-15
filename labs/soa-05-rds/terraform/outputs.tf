# outputs.tf
#
# Plain English: what the dashboard shows once lab 05 is up (AWS labs spec §4, §10).
# The two mysql lines run on vm-client.

output "private_ips" {
  value = {
    "vm-client"  = aws_instance.client.private_ip
    "db-primary" = aws_db_instance.primary.address
    "db-replica" = aws_db_instance.replica.address
  }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.client.id} --os-user labadmin --connection-type eice",
    "ssh labadmin@${aws_instance.client.private_ip}",
    "mysql -e 'SELECT @@hostname, @@version'",
    "mysql --defaults-group-suffix=-replica -e 'SHOW REPLICA STATUS\\G'",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
