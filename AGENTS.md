# CCPA Agent Instructions

## Mandatory Claude Review

All code-writing work in this repository must include a synchronous Claude Code
review before commit or push.

Required workflow:

1. Implement changes with focused tests.
2. Run the relevant local verification.
3. Ask Claude Code to review the staged diff or the candidate commit in
   read-only mode.
4. Treat any Claude finding marked blocking, high, security, correctness, or
   regression as mandatory to address before commit or push.
5. Record the Claude review outcome in the handoff or final response.

Recommended local command shape:

```bash
DIFF_FILE="$(mktemp /tmp/ccpa-claude-review-XXXXXX.diff)"
git diff --cached --no-color > "$DIFF_FILE"
claude -p "Review the staged CCPA diff in $DIFF_FILE. Focus on security, correctness, regressions, and missing tests. Output findings first. Do not modify files." \
  --output-format json \
  --no-session-persistence \
  --safe-mode \
  --permission-mode plan \
  --allowedTools Read,Grep,Glob,LS
```

If reviewing an already-created commit, use `git show --no-color HEAD` instead
of `git diff --cached`.
