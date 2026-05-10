#!/bin/bash

get_timestamp() {
    date -u +"%Y-%m-%d %H:%M:%S UTC"
}
TIMESTAMP=$(get_timestamp)

get_git_source() {
    RES=$(git remote get-url origin 2>/dev/null)
    RES="${RES:-unknown}"
    [[ "$RES" == git@* ]] && RES=$(echo "$RES" | sed 's|^git@\([^:]*\):\(.*\)|https://\1/\2|')
    RES="${RES%.git}"
    echo "${RES}"
}
GIT_SOURCE=$(get_git_source)

get_git_commit() {
    git rev-parse HEAD
}
GIT_COMMIT=$(get_git_commit)

get_git_tag() {
    git describe --tags --abbrev=0 2>/dev/null || echo
}
GIT_TAG=$(get_git_tag)

get_git_clean_status() {
    [ -z "$(git status --porcelain)" ] && echo Clean || echo Uncommitted changes
}
GIT_CLEAN_STATUS=$(get_git_clean_status)

json_escape() {
    local LC_ALL=C
    local s=$1
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\b'/\\b}
    s=${s//$'\f'/\\f}
    s=${s//$'\n'/\\n}
    s=${s//$'\r'/\\r}
    s=${s//$'\t'/\\t}

    [[ "$s" != *[[:cntrl:]]* ]] ||
        { echo "unhandled control character in JSON string" >&2; exit 1; }

    printf '%s' "$s"
}

GITMETADATAJSON=gitmetadata.json

{
    printf '{\n'
    printf '  "timestamp": "%s",\n' "$(json_escape "$TIMESTAMP")"
    printf '  "git_source": "%s",\n' "$(json_escape "$GIT_SOURCE")"
    printf '  "git_commit": "%s",\n' "$(json_escape "$GIT_COMMIT")"
    printf '  "git_tag": "%s",\n' "$(json_escape "$GIT_TAG")"
    printf '  "git_clean_status": "%s"\n' "$(json_escape "$GIT_CLEAN_STATUS")"
    printf '}\n'
} > "$GITMETADATAJSON"

cargo build --release
ln -snf target/wasm32-unknown-unknown/release/blake3_wasm_streaming.wasm .
