# Discussion Release Action

This action for GitHub Actions creates release discussions and posts comments to
them on every release.

On a release, a GitHub Discussion is looked up or created for the current cycle.
A comment is then posted to the discussion with the release notes. A TOC is also
added to the discussion description and kept up to date with every release.

This action works particularly well with [changesets](https://github.com/changesets/action)
and makes it so that the release notes of all your packages are posted to a
single discussion category.

Note that the comments are updated when you edit a release. This way, the release
is the source of truth. Omit the `edited` and `deleted` triggers if you don't want
this and want to be able to edit release notes in the discussion instead.

Example workflow:

```yaml
name: Release To Discussions

on:
  release:
    types: [created, edited, deleted]

# you want to prevent race conditions when multiple releases are
# created at the same time, which happens often in mono-repos.
concurrency: release-discussion-action

jobs:
  publish-release-notes:
  name: Publish Release Notes
  runs-on: ubuntu-latest

  steps:
    - name: publish discussion
      uses: magicbell-io/release-discussion-action@main
      with:
        # the repository where the discussions are hosted
        repo: magicbell-io/community
        # category slug, can be found in the URL of the category page
        category: product-changelog
        # group releases by week or month
        cycle: week
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```
