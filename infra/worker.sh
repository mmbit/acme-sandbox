#!/usr/bin/env bash
# Defines worker staging. Source from the repository checkout with work set to the work volume's mount point.
stage_worker_code() {
  [ -n "$work" ] || return 0   # A new server creates the volume when the stack comes up.
  local code="$work/code" configuration revision directory name
  local -a paths=(HEAD:platform/worker)
  configuration=$(git ls-tree --name-only HEAD -- company/worker-capacity.json) || return 1
  [ -z "$configuration" ] || paths+=("HEAD:$configuration")
  revision=$(git rev-parse "${paths[@]}" | sha256sum | cut -d' ' -f1) || return 1
  mkdir -p "$code" && chmod 755 "$code" || return 1
  if [ ! -d "$code/$revision" ]; then
    rm -rf "$code/$revision.new" && mkdir "$code/$revision.new" &&
      git archive HEAD platform/worker | tar -x --no-same-owner --strip-components=2 -C "$code/$revision.new" || return 1
    if [ -n "$configuration" ]; then
      git show "HEAD:$configuration" > "$code/$revision.new/capacity.json" || return 1
    fi
    ln -s /opt/gates/platform/worker/node_modules "$code/$revision.new/node_modules" &&
      mv "$code/$revision.new" "$code/$revision" || return 1
  fi
  if [ "$(readlink "$code/current")" != "$revision" ]; then
    ln -sfn "$revision" "$code/current.new" && mv -T "$code/current.new" "$code/current" || return 1
  fi
  # A reload reads the new revision before the old process leaves, so both stay until neither is running nor current.
  for directory in "$code"/*; do
    [ -d "$directory" ] && [ ! -L "$directory" ] || continue
    name=$(basename "$directory")
    [ "$name" = "$revision" ] || [ "$name" = "$(readlink "$code/running")" ] || rm -rf "${code:?}/$name" || return 1
  done
}
