# lambda/api.py
#
# Plain English: lab 12's API behind API Gateway's HTTP API (payload format
# 2.0). GET /health answers anyone; GET /items lists up to 50 items and
# POST /items stores one, both only for a signed-in user of the lab's Cognito
# pool (the JWT authoriser checks the token before this code runs), recorded
# with the user name the token carries.

import json
import os
import uuid
from datetime import datetime, timezone

import boto3

TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE"])


def reply(status, body):
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(body, default=str)}


def handler(event, _context):
    route = event.get("routeKey", "")
    if route == "GET /health":
        return reply(200, {"ok": True})
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    who = claims.get("cognito:username") or claims.get("username") or "unknown"
    if route == "GET /items":
        return reply(200, {"you": who, "items": TABLE.scan(Limit=50).get("Items", [])})
    if route == "POST /items":
        try:
            body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return reply(400, {"error": "the body must be JSON"})
        item = {"id": str(uuid.uuid4()), "text": str(body.get("text", ""))[:200], "by": who, "at": datetime.now(timezone.utc).isoformat()}
        TABLE.put_item(Item=item)
        return reply(201, item)
    return reply(404, {"error": f"no route {route}"})
