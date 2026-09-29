# Fork workflow

The fork `Cordtus/opencode` keeps **two long-lived branches**, and this rule avoids the "can't fast-forward"
pain of merging features into a mirror:

- **`v2`** — a read-only mirror of `anomalyco/opencode:v2`. Never merge feature work into it.
- **`integration`** — the fork's integration branch (mirror + fork-only work). Feature PRs target `integration`.

## Sync the mirror

```sh
git fetch origin
git push fork origin/v2:refs/heads/v2          # fast-forward; no --force needed unless you merged into it
```

## Update `integration` with upstream

```sh
git checkout integration
git merge origin/v2
```

## Start a feature

```sh
git checkout -b my-feature integration
# ...commit, then:
git push -u fork my-feature
gh pr create --repo Cordtus/opencode --base integration --head my-feature
```

## Recover a mirror that was merged into

If a feature was accidentally merged into `v2`, reset the mirror (the feature is preserved on its branch):

```sh
git push fork origin/v2:refs/heads/v2 --force-with-lease
```

## Dev launcher note

`bin/opencode-local` runs whatever is checked out, so run it from a work branch or `integration`, not from the mirror.
