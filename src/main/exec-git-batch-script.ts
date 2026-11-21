/**
 * exec-git-batch-script.ts — the constant shell script a git batch runs (exec-git-batch.ts has the
 * design: the framing, why the answer cannot be forged, what a command can be).
 */

/**
 * `$1` checkout, `$2` nonce, then groups of `<dir> <n> <n arguments>`. For
 * dir `c` the arguments are git's, run in the checkout. For `w` the first is a
 * worktree path and the rest are git's: they run in that worktree only if
 * `git worktree list` (run here, once) names exactly that path. Each command's
 * stderr is kept to 2 KiB: its first line is what a Git view shows for a failure.
 */
export const BATCH_SCRIPT = `cwd=$1; nonce=$2; shift 2
GIT_OPTIONAL_LOCKS=0; GIT_TERMINAL_PROMPT=0; export GIT_OPTIONAL_LOCKS GIT_TERMINAL_PROMPT
errf=$(mktemp) || exit 125
fpd=
trap 'rm -f -- "$errf"; if [ -n "$fpd" ]; then rm -rf -- "$fpd"; fi' EXIT HUP INT TERM
listed=0
is_listed() {
  if [ "$listed" = 0 ]; then
    wl=$(git -C "$cwd" worktree list --porcelain 2>/dev/null)
    listed=1
  fi
  found=1
  while IFS= read -r line; do
    if [ "$line" = "worktree $1" ]; then found=0; fi
  done <<WMUX_EOF
$wl
WMUX_EOF
  return $found
}
# One worktree's per-file keys: for every file the worktree reports (the path of
# each status record, a rename's original path, each modified or untracked file) a
# digest of its path and a digest of what decides its diff, the status lines that
# name it plus its stat line. One awk pass writes the records to files, so that ONE
# hash process digests them all. At most 100 files: past that the worktree has no
# per-file keys and prints no C line. C says the keys are complete: a file without
# one is clean.
fingerprint_files() {
  fk=$1
  anames=$(LC_ALL=C awk -v dir="$fpd" -v k="$fk" -v sf="$fpd/s$fk" '
    function skip(line, n,   i, pos) {
      for (i = 0; i < n; i++) { pos = index(line, " "); if (!pos) return ""; line = substr(line, pos + 1) }
      return line
    }
    function note(p, line) { if (p == "") return; if (!(p in seen)) { seen[p] = 1; n++ } rec[p] = rec[p] line "\\n" }
    FILENAME == sf {
      t = substr($0, 1, 2)
      if (t == "1 ") p = skip($0, 8)
      else if (t == "2 ") p = skip($0, 9)
      else if (t == "u ") p = skip($0, 10)
      else if (t == "? ") p = skip($0, 2)
      else if (t == "# " || t == "! ") p = ""
      else p = $0
      note(p, $0)
      next
    }
    substr($0, 1, 2) == "F|" { note(skip4($0), $0) }
    function skip4(line,   i, pos) {
      for (i = 0; i < 4; i++) { pos = index(line, "|"); if (!pos) return ""; line = substr(line, pos + 1) }
      return line
    }
    END {
      if (n > 100) exit 3
      for (p in seen) {
        i++
        printf "%s", p > (dir "/p" k "_" i); close(dir "/p" k "_" i)
        printf "%s", rec[p] > (dir "/r" k "_" i); close(dir "/r" k "_" i)
        printf " p%s_%s r%s_%s", k, i, k, i
      }
    }' "$fpd/s$fk" "$fpd/f$fk") || return 0
  names="$names$anames"
  printf 'C %s\\n' "$fk"
}
# The fingerprint as short digests, made here with $hasher: the top level, a
# digest of the refs, and per worktree a digest of its status lines, one of its
# stat lines and the per-file keys above.
fingerprint_digest() {
  printf 'V %s\\n' "$algo"
  printf 'T %s\\n' "$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null </dev/null)"
  git -C "$cwd" for-each-ref --format='%(objectname) %(refname)' 2>/dev/null </dev/null >"$fpd/refs"
  names=refs
  wts=$(git -C "$cwd" worktree list --porcelain 2>/dev/null </dev/null | sed -n 's/^worktree //p')
  k=0
  while IFS= read -r w; do
    [ -n "$w" ] || continue
    k=$((k+1))
    printf 'W %s %s\\n' "$k" "$w"
    git -C "$w" status --porcelain=v2 --branch -z -unormal 2>/dev/null </dev/null | tr '\\0' '\\n' >"$fpd/s$k"
    : >"$fpd/f$k"
    list=$(git -C "$w" ls-files -m -o --exclude-standard -z 2>/dev/null </dev/null | tr '\\0' '\\n')
    if [ -n "$list" ]; then
      count=$(( $(printf '%s\\n' "$list" | wc -l) ))
      if [ "$count" -gt 2000 ]; then
        printf 'CAPPED\\n'
      else
        printf '%s\\n' "$list" | tr '\\n' '\\0' | (cd "$w" 2>/dev/null && xargs -0 stat -c 'F|%s|%Y|%y|%n' 2>/dev/null) >"$fpd/f$k"
      fi
    fi
    names="$names s$k f$k"
    fingerprint_files "$k"
  done <<WMUX_FP_EOF
$wts
WMUX_FP_EOF
  hashes=$(cd "$fpd" && $hasher $names) || return 1
  while read -r h n; do
    h16=\${h%"\${h#????????????????}"}
    h12=\${h%"\${h#????????????}"}
    case $n in
      refs) printf 'RD %s\\n' "$h16";;
      s*) printf 'SD %s %s\\n' "\${n#s}" "$h16";;
      f*) printf 'ZD %s %s\\n' "\${n#f}" "$h16";;
      p*) ph=$h12;;
      r*) kk=\${n#r}; printf 'K %s %s %s\\n' "\${kk%_*}" "$ph" "$h12";;
    esac
  done <<WMUX_FH_EOF
$hashes
WMUX_FH_EOF
}
# What a poll asks: a few hundred bytes of digests, parsed by exec-snapshot.ts. A host
# with no hash tool, no awk or no mktemp -d says NOHASH, and the poll runs unshortcut.
fingerprint() {
  if ! stat -c %s "$cwd" >/dev/null 2>&1; then printf 'NOSTAT\\n'; return 0; fi
  hasher=; algo=
  if command -v sha1sum >/dev/null 2>&1; then hasher=sha1sum; algo=sha1
  elif command -v md5sum >/dev/null 2>&1; then hasher=md5sum; algo=md5; fi
  if [ -n "$hasher" ] && command -v awk >/dev/null 2>&1; then fpd=$(mktemp -d "\${TMPDIR:-/tmp}/wmux-f.XXXXXX" 2>/dev/null) || fpd=; fi
  if [ -n "$fpd" ] && digest=$(fingerprint_digest); then
    printf '%s\\n' "$digest"
  else
    printf 'NOHASH\\n'
  fi
  if [ -n "$fpd" ]; then rm -rf -- "$fpd"; fpd=; fi
}
run_one() {
  dir=$1; n=$2; shift 2
  : > "$errf"
  total=$#; k=0
  while [ "$k" -lt "$total" ]; do
    if [ "$k" -lt "$n" ]; then set -- "$@" "$1"; fi
    shift; k=$((k+1))
  done
  if [ "$dir" = f ]; then
    fingerprint 2>"$errf"
  elif [ "$dir" = w ]; then
    wt=$1; shift
    is_listed "$wt" || return 125
    git -C "$wt" "$@" 2>"$errf" </dev/null
  else
    git -C "$cwd" "$@" 2>"$errf" </dev/null
  fi
}
i=0
while [ $# -gt 0 ]; do
  n=$2
  i=$((i+1))
  run_one "$@"
  st=$?
  printf '\\n--%s:%s:%s\\n' "$nonce" "$i" "$st"
  head -c 2048 "$errf"
  printf '\\n--%s:%s:E\\n' "$nonce" "$i"
  shift $((n+2))
done
exit 0
`;
