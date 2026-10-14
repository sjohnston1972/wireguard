# aws-token.sh: sourced by every step that talks to AWS.
#
# Plain English: fetch a fresh signed identity from GitHub for AWS (audience
# sts.amazonaws.com). The AWS provider and CLI trade it for the
# wg-admin-deploy role (AWS_ROLE_ARN). Tokens last minutes and a run can last
# longer, so each step gets its own. Never printed. A missing token fails the
# step rather than saving the word "null".
( umask 077; curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -er .value > "$RUNNER_TEMP/aws-token" )
chmod 600 "$RUNNER_TEMP/aws-token"
export AWS_WEB_IDENTITY_TOKEN_FILE="$RUNNER_TEMP/aws-token"
