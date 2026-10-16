An API with no servers at all: API Gateway's HTTP API takes the requests, a Lambda function does the work, a DynamoDB table keeps the data, and a Cognito user pool decides who may call it. API Gateway checks each caller's token itself, so the function only ever sees signed-in users on `/items`. Everything is listed in the lab's resource group, `lab-saa-12-serverless-api`, in AWS Resource Groups (London).
From the SAA-C03 outline: design secure access to application tiers with an identity provider, and choose serverless, scale-to-zero services for resilient, high-performing designs.

## What it deploys

- The HTTP API `lab-saa-12-serverless-api` (Name `api-lab`): `GET /health` for anyone; `GET /items` and `POST /items` only with a token from the lab's user pool, checked by a JWT authoriser; the `$default` stage, throttled to 10 requests at once and 5 a second
- The function `lab-saa-12-serverless-api-api` (Python 3.13, arm64, 128 MB), logging to `/cloudlabs/saa-12-serverless-api/api`, running as the role `lab-saa-12-serverless-api-api`, which may only read and write the lab's table
- The table `lab-saa-12-serverless-api-items` (DynamoDB on demand)
- The user pool `lab-saa-12-serverless-api-users` (Lite tier, administrators make users), its app client `lab-saa-12-serverless-api-cli`, and one user, `labuser`, whose password is the session password (behind **Show**)

```text
lab-saa-12-serverless-api (London)
  you (CloudShell) --sign in--> pool-users --> ID token (JWT)
  you --HTTPS + token--> api-lab [JWT authoriser: pool-users, client cli] --> fn-api --> table-items
  GET /health needs no token
```

## Things to try

- Open CloudShell and run the first Connect line: `/health` answers without a token. Ask for `/items` without one and see API Gateway refuse it with 401 before the function runs (`curl -s -o /dev/null -w "%{http_code}\n" <api>/items`) (no new line in the function's log).
- Sign in with the second line (paste the session password), then add an item with the third and list them with the fourth: each item records who stored it, from the token's `cognito:username` claim. The token lasts an hour; run the second line again for a new one.
- Decode the token locally with `echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null; echo` and read its claims: issuer, audience (the app client), expiry. Change one character and call again: 401.
- Send 50 requests at once (`for i in $(seq 50); do curl -s -o /dev/null -w "%{http_code}\n" <api>/health & done; wait`) and count the 429s: the stage's throttle at work.
- Open the table in the DynamoDB console and look at its capacity mode: on demand bills each read and write, so an idle table costs nothing but its storage.

## Learn more

- [Control access to HTTP APIs with JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
- [Amazon Cognito user pools](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-identity-pools.html)
- [Using Lambda with API Gateway](https://docs.aws.amazon.com/lambda/latest/dg/services-apigateway.html)
- [DynamoDB throughput capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/capacity-mode.html)
- [Throttle requests to your HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-12-serverless-api` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
