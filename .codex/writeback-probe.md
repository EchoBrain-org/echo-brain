# Codex Cloud write-back probe

This temporary file verifies that a GitHub `@codex` task can update its pull-request branch without a local machine.

status: verified

The Cloud task must change only `status: seed` to `status: verified`, commit the change, and push it to this pull-request branch.
