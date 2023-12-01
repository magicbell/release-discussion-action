import * as core from "@actions/core";
import * as github from "@actions/github";

import {
  addDiscussionComment,
  createDiscussion,
  deleteDiscussionComment,
  getDiscussionById,
  getRepository,
  searchDiscussions,
  updateDiscussion,
  updateDiscussionComment
} from "./queries";

const full_name = core.getInput('repo');
const [owner, repo] = full_name.split("/");
const categorySlug = core.getInput('category');
const cycleLength = core.getInput('cycle') === 'month' ? 'month' :'week';

function getWeekNumber(date = new Date()) {
  const startDate = new Date(date.getFullYear(), 0, 1);
  const days = Math.floor((date.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000) + 1);
  return Math.ceil(days / 7);
}

function getFirstDayOfWeek(weekNumber: number, year: number) {
  const startDate = new Date(year, 0, 1);
  const dayNum = startDate.getDay();
  const diff = --weekNumber * 7;

  // Adjust if the year starts on a day other than Monday
  if (dayNum !== 1) {
    startDate.setDate(startDate.getDate() - (dayNum - 1));
  }

  startDate.setDate(startDate.getDate() + diff);
  return startDate;
}

function getFirstDayOfMonth(month: number, year: number) {
  return new Date(year, month, 1);
}

function getCycleId(date: Date, cycleLength: 'month' | 'week') {
  if (cycleLength === 'week') return `${date.getFullYear()}W${getWeekNumber(date)}`;
  return `${new Date(date.getFullYear(), date.getMonth(), 1).toISOString().substring(0, 7)}`
}

function getCycleName(date: Date, cycleLength: 'month' | 'week') {
  if (cycleLength === 'week') return `${date.getFullYear()} Week ${getWeekNumber(date)}`;
  return `${date.getFullYear()} ${date.toLocaleString("default", { month: "long" })}`
}

async function main() {
  try {
    const isDeleteRequest = github.context.payload.action === 'deleted';
    const release = github.context.payload.release;
    const isPrivate = Boolean(github.context.payload.repository?.private);
    const releaseDate = new Date(github.context.payload.release.published_at);

    if (release.draft) return;

    const repository = await getRepository({ owner, repo, category: categorySlug });
    const category = repository.discussionCategory;

    if (!category) {
      core.setFailed(`Category "${categorySlug}" not found, please ensure the category slug is correct.`);
      process.exit(1);
    }

    const cycleIdentifier = `<!-- release-cycle:${getCycleId(releaseDate, cycleLength)} -->`;
    const cycleName = getCycleName(releaseDate, cycleLength);

    const from = cycleLength === 'week'
        ? getFirstDayOfWeek(getWeekNumber(releaseDate), releaseDate.getFullYear())
        : getFirstDayOfMonth(releaseDate.getFullYear(), releaseDate.getMonth());

    const to = cycleLength === 'week'
        ? getFirstDayOfWeek(getWeekNumber(releaseDate) + 1, releaseDate.getFullYear())
        : getFirstDayOfMonth(releaseDate.getFullYear(), releaseDate.getMonth() + 1);

    // note, the github api doesn't search for the exact string, we need to filter the results
    const searchResult = await searchDiscussions({
      repo: full_name,
      category: category.name,
      from,
      to,
      search: cycleIdentifier,
    });

    console.log(JSON.stringify({
      identifier: cycleIdentifier,
      from,
      to,
      searchResult
    }, null, 2));


    let discussion = searchResult.find(node => node.body.includes(cycleIdentifier));

    if (discussion) {
      core.info(`Using discussion ${discussion!.title} - ${discussion!.url}`);
    } else {
      core.info(`Discussion not found, creating new discussion for "${cycleName}"`);

      // create the discussion, as non was found
      discussion = await createDiscussion({
        repositoryId: repository.id,
        categoryId: category.id,
        title: `Releases - ${cycleName}`,
        body: `${cycleIdentifier}\n\n<!-- START-RELEASE-TOC -->\n<!-- END-RELEASE-TOC -->`,
      })

      core.info(`Created discussion ${discussion!.title} - ${discussion!.url}`);
    }

    const releaseName = `${release.name}@${release.tag_name}`;
    const releaseIdentifier = `<!-- release-item:${releaseName} -->`;


    // get the discussion again, as we need the comments
    let { comments } = await getDiscussionById({
      discussionId: discussion!.id
    });

    let comment = comments.find(node => node.body.includes(releaseIdentifier));
    const title = isPrivate ? releaseName : `[${releaseName}](${release.html_url})`;
    const body = `${releaseIdentifier}\n\n### ${title}\n\n${release.body}`;


    if (isDeleteRequest && comment) {
      await deleteDiscussionComment({ commentId: comment!.id });
      comments = comments.filter(x => x.id !== comment?.id);
      core.info(`Deleted comment ${releaseName} - ${comment!.url}`);
    } else if (isDeleteRequest) {
      core.info(`Comment for ${releaseName} not found, nothing to delete.`)
    } else if (comment) {
      // update existing comment with updated release info
      comment = await updateDiscussionComment({ commentId: comment!.id, body });
      comments = comments.map(x => x.id === comment!.id ? comment! : x);
      core.info(`Updated comment ${releaseName} - ${comment!.url}`);
    } else {
      // create new comment with release info
      comment = await addDiscussionComment({ discussionId: discussion!.id, body });
      comments.push(comment!);
      core.info(`Created comment ${releaseName} - ${comment!.url}`);
    }

    const releases = {};

    console.log(JSON.stringify({ comments }, null, 2));

    for (const comment of comments) {
      const match = comment.body.match(/<!-- release-item:(.*?)@(.*?) -->/);
      if (!match) continue;

      const name = match![1].trim();
      const version = match![2].trim();

      releases[name] ??= [];
      releases[name].push({
        id: comment.id,
        name,
        version,
        url: comment.url,
      });
    }

    const tocLines = ['**Releases**\n'];

    for (const name of Object.keys(releases).sort()) {
      for (const release of releases[name]) {
        tocLines.push(`- [**${release.name}**: ${release.version}](${release.url})`);
      }
    }

    const tocMarkdown = tocLines.join("\n").trim();
    console.log(JSON.stringify({ tocLines, tocMarkdown }, null, 2));

    const newBody = discussion!.body
      .replace(/(<!-- START-RELEASE-TOC -->)[\s\S]*?(<!-- END-RELEASE-TOC -->)/, `$1\n${tocMarkdown}\n$2`);

    if (newBody.replace(/\s/g, '') !== discussion!.body.replace(/\s/g, '')) {
      await updateDiscussion({ discussionId: discussion!.id, body: newBody });
      core.info(`Updated TOC in discussion ${discussion!.url}`);
    }
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

main();
