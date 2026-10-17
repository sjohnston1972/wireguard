# athena.tf
#
# Plain English: lab 28's way to query the S3 flow logs with SQL. The Glue
# database lab_<id> (Glue takes no hyphens; A97) holds one table,
# vpc_flow_logs, over the bucket's AWSLogs/ folder: the default (version 2)
# flow-log fields, read as space-separated text, partitioned like the
# folders the flow log writes. Partition projection works the partitions out
# from the query itself, so nothing has to load them. The Athena workgroup
# lab-<id>-wg keeps its results in the same bucket under athena/, refuses any
# query that would scan more than 10 MB, and is deleted with its queries.

locals {
  glue_db = "lab_${replace(var.lab_id, "-", "_")}"
}

resource "aws_glue_catalog_database" "flow" {
  name        = local.glue_db
  description = "lab ${var.lab_id}: the flow logs' table"
  tags        = { Name = "glue-flowlogs" }
}

resource "aws_glue_catalog_table" "flow" {
  name          = "vpc_flow_logs"
  database_name = aws_glue_catalog_database.flow.name
  table_type    = "EXTERNAL_TABLE"
  description   = "lab ${var.lab_id}: vpc-service flow logs in S3, partitioned by the hour"
  parameters = {
    "EXTERNAL"                         = "TRUE"
    "skip.header.line.count"           = "1"
    "projection.enabled"               = "true"
    "projection.aws-account-id.type"   = "enum"
    "projection.aws-account-id.values" = local.account
    "projection.aws-service.type"      = "enum"
    "projection.aws-service.values"    = "vpcflowlogs"
    "projection.aws-region.type"       = "enum"
    "projection.aws-region.values"     = var.region
    "projection.year.type"             = "integer"
    "projection.year.range"            = "2026,2036"
    "projection.month.type"            = "integer"
    "projection.month.range"           = "1,12"
    "projection.month.digits"          = "2"
    "projection.day.type"              = "integer"
    "projection.day.range"             = "1,31"
    "projection.day.digits"            = "2"
    "projection.hour.type"             = "integer"
    "projection.hour.range"            = "0,23"
    "projection.hour.digits"           = "2"
  }

  partition_keys {
    name = "aws-account-id"
    type = "string"
  }
  partition_keys {
    name = "aws-service"
    type = "string"
  }
  partition_keys {
    name = "aws-region"
    type = "string"
  }
  partition_keys {
    name = "year"
    type = "string"
  }
  partition_keys {
    name = "month"
    type = "string"
  }
  partition_keys {
    name = "day"
    type = "string"
  }
  partition_keys {
    name = "hour"
    type = "string"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.flowlogs.bucket}/AWSLogs/"
    input_format  = "org.apache.hadoop.mapred.TextInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"
    ser_de_info {
      serialization_library = "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe"
      parameters = {
        "field.delim"          = " "
        "serialization.format" = " "
      }
    }
    columns {
      name = "version"
      type = "int"
    }
    columns {
      name = "account_id"
      type = "string"
    }
    columns {
      name = "interface_id"
      type = "string"
    }
    columns {
      name = "srcaddr"
      type = "string"
    }
    columns {
      name = "dstaddr"
      type = "string"
    }
    columns {
      name = "srcport"
      type = "int"
    }
    columns {
      name = "dstport"
      type = "int"
    }
    columns {
      name = "protocol"
      type = "bigint"
    }
    columns {
      name = "packets"
      type = "bigint"
    }
    columns {
      name = "bytes"
      type = "bigint"
    }
    columns {
      name = "start"
      type = "bigint"
    }
    columns {
      name = "end"
      type = "bigint"
    }
    columns {
      name = "action"
      type = "string"
    }
    columns {
      name = "log_status"
      type = "string"
    }
  }
}

resource "aws_athena_workgroup" "flow" {
  name          = "lab-${var.lab_id}-wg"
  force_destroy = true
  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = false
    bytes_scanned_cutoff_per_query     = 10485760
    result_configuration {
      output_location = "s3://${aws_s3_bucket.flowlogs.bucket}/athena/"
    }
  }
  tags = { Name = "athena-wg" }
}
