# infra/ci/aws-lab-creds.sh <role-arn> [seconds]: sourced by each lab-aws.yml step that talks to AWS.
#
# Plain English: the step's own AWS session (AWS labs spec §5). It fetches a
# fresh signed identity from GitHub for AWS (audience sts.amazonaws.com, as
# aws-token.sh), trades it with STS for a session of the role named by its
# ARN (wg-admin-labs for 3 hours, ruling A14; wg-admin-deploy for 1 hour, its
# maximum, ruling A32) and exports the session for this step only:
#
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN   masked first
#   AWS_REGION, AWS_DEFAULT_REGION                                $LAB_REGION (eu-west-2)
#
# and unsets AWS_ENDPOINT_URL_S3, so nothing this step runs can talk to R2
# with the session. The GitHub token goes to STS by file (umask 077, deleted
# straight after), never on a command line; the role's ARN (it holds the
# account id) is never printed. Sourced, so it never exits the step: when
# GitHub or STS refuses it prints one ::error:: line and returns 1, and the
# step decides (Peer and Unpeer carry on without peering; the rest fail).
# Source it before live-log.sh, so the live log's filter knows the values.

_aws_lab_creds() {
  local role="${1:-}" secs="${2:-10800}" name tok out ak sk st region
  name="${role##*/}"
  name="${name:-AWS}"
  region="${LAB_REGION:-eu-west-2}"
  tok="${RUNNER_TEMP:-/tmp}/aws-lab-token"
  if [ -z "$role" ] || ! [[ "$secs" =~ ^[0-9]+$ ]]; then
    echo "::error::GitHub or AWS STS refused the $name session (usage: aws-lab-creds.sh <role-arn> [seconds])"
    return 1
  fi
  if ! (set -o pipefail; umask 077; curl -fsS -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" "${ACTIONS_ID_TOKEN_REQUEST_URL:-}&audience=sts.amazonaws.com" | jq -er .value > "$tok"); then
    rm -f "$tok"
    echo "::error::GitHub or AWS STS refused the $name session (no GitHub identity token)"
    return 1
  fi
  # Only the session's own three values: no keys the step may already hold go to STS.
  if ! out="$(env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN aws sts assume-role-with-web-identity \
    --role-arn "$role" --role-session-name "lab-${LAB_ID:-none}-${GITHUB_RUN_ID:-0}" \
    --web-identity-token "file://$tok" --duration-seconds "$secs" \
    --query Credentials --region "$region" --output json 2>/dev/null)"; then
    rm -f "$tok"
    echo "::error::GitHub or AWS STS refused the $name session"
    return 1
  fi
  rm -f "$tok"
  if ! ak="$(jq -er '.AccessKeyId' <<<"$out")" || ! sk="$(jq -er '.SecretAccessKey' <<<"$out")" || ! st="$(jq -er '.SessionToken' <<<"$out")"; then
    echo "::error::GitHub or AWS STS refused the $name session (no credentials in the answer)"
    return 1
  fi
  echo "::add-mask::$ak"
  echo "::add-mask::$sk"
  echo "::add-mask::$st"
  export AWS_ACCESS_KEY_ID="$ak" AWS_SECRET_ACCESS_KEY="$sk" AWS_SESSION_TOKEN="$st"
  export AWS_REGION="$region" AWS_DEFAULT_REGION="$region"
  unset AWS_ENDPOINT_URL_S3
  echo "AWS session for $name: ${secs} s in $region"
}

if _aws_lab_creds "$@"; then
  unset -f _aws_lab_creds
else
  unset -f _aws_lab_creds
  return 1
fi
