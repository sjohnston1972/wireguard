# data.tf
#
# Plain English: lab 12's table, lab-<id>-items: DynamoDB on demand (billed
# per request, nothing while idle; ruling P12), keyed by an id, deletable at
# tear-down. Named lab-<id>-* so the safety net also finds it by name
# (ruling P3).

resource "aws_dynamodb_table" "items" {
  name                        = "lab-${var.lab_id}-items"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "id"
  deletion_protection_enabled = false

  attribute {
    name = "id"
    type = "S"
  }
  tags = { Name = "table-items" }
}
