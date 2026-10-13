// The bash an update leaves running when the app quits (ADR-0035). The app
// writes one into its 0700 updater folder and starts it detached. Every value
// arrives as an argument, checked here again: nothing is written into the text.
// Both write updater/outcome.json, {schema_version, release, attempt, status},
// by rename. The attempt is the app's id for the click that started this
// script: a relauncher from before a quit can still finish after a new one starts.

const OUTCOME = `
[[ $release =~ ^clean-v1-[a-z0-9][a-z0-9-]{2,63}$ ]] || exit 2
[[ $attempt =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 2
finish() {
  printf '{"schema_version":1,"release":"%s","attempt":"%s","status":"%s"}' "$release" "$attempt" "$1" > "$outcome.$$" && mv -f "$outcome.$$" "$outcome"
}`;

/**
 * macOS: `pid bundle staged previous outcome release attempt open [wait seconds]`.
 * Waits for the app to quit (two minutes by default), moves the bundle to
 * previous and the staged one into its place, then opens whichever is there.
 * A failed move puts the old bundle back. An app that never quits keeps both.
 */
export const SWAP_HELPER = `#!/bin/bash
set -u
umask 077
[ "$#" -ge 8 ] || exit 2
pid=$1 bundle=$2 staged=$3 previous=$4 outcome=$5 release=$6 attempt=$7 open=$8 limit=120
if [ "$#" -ge 9 ]; then limit=$9; fi
${OUTCOME}
for ((tick = 0; tick < limit * 4; tick++)); do
  kill -0 "$pid" 2> /dev/null || break
  sleep 0.25
done
if kill -0 "$pid" 2> /dev/null; then
  finish failed
  exit 1
fi
status=failed
rm -rf "$previous"
if mkdir -p "$(dirname "$previous")" && mv "$bundle" "$previous"; then
  if mv "$staged" "$bundle"; then status=installed; else mv "$previous" "$bundle"; fi
fi
finish "$status"
"$open" "$bundle"
`;

/**
 * Linux: `pid feed deb progress outcome release attempt pkexec helper launcher`.
 * Runs the root helper under pkexec with its output in the progress file,
 * after a first line naming the attempt; the helper's "verified" tells that
 * attempt's app to quit. Records how it ended: 0 installed, 126 a cancelled
 * prompt, anything else failed. ECHO is reopened only once the app has quit;
 * a cancelled prompt leaves it open.
 */
export const RELAUNCHER = `#!/bin/bash
set -u
umask 077
[ "$#" -eq 10 ] || exit 2
pid=$1 feed=$2 deb=$3 progress=$4 outcome=$5 release=$6 attempt=$7 pkexec=$8 helper=$9 launcher=\${10}
${OUTCOME}
{
  printf 'attempt %s\\n' "$attempt"
  "$pkexec" "$helper" install --feed "$feed" --deb "$deb" --wait-pid "$pid" < /dev/null 2> /dev/null
} > "$progress"
case $? in
  0) finish installed ;;
  126) finish cancelled ;;
  *) finish failed ;;
esac
if ! kill -0 "$pid" 2> /dev/null; then
  setsid "$launcher" < /dev/null > /dev/null 2>&1 &
fi
`;
