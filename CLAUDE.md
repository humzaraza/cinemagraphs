@AGENTS.md

## Filesystem Safety

NEVER run multiple `rm -rf` or `npm install` commands concurrently. Always wait for each command to fully complete before starting the next. Never retry a failed `rm -rf` automatically — ask the user to handle it if it fails. Never stack destructive filesystem commands.
