const core = require("@actions/core");
const github = require('@actions/github');

const full_name = core.getInput('repo');
const [owner, repo] = full_name.split("/");
const categorySlug = core.getInput('category');
const token = process.env.GITHUB_TOKEN;

const octokit = github.getOctokit(token);
const graphql = octokit.graphql.defaults({
    headers: {
        authorization: `bearer ${token}`,
    }
});

// Get the current month and year
const currentDate = new Date();
const currentMonth = currentDate.toLocaleString("default", { month: "long" });
const currentYear = currentDate.getFullYear();

// note: octokit does not support variables named `query`
const SEARCH_QUERY = `query search($qry: String!) {
  search (type: DISCUSSION, first: 100, query: $qry) {
    nodes {
      ... on Discussion {
        id
        title
        body
        url
      }
    }
  }
}`;

const DISCUSSION_BY_ID_QUERY = `query node($id: ID!, $first: Int = 100, $after: String) {
  node(id: $id) {
    ...on Discussion {
      comments (first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }

        nodes {
          id
          body
          url
        }
      }
    }
  }
}`;

const CREATE_DISCUSSION_MUTATION = `mutation createDiscussion($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
  createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) {
    discussion {
      id
      title
      body
      url
    }
  }
}`;

const UPDATE_DISCUSSION_MUTATION = `mutation updateDiscussion($discussionId: ID!, $body: String!) {
  updateDiscussion(input: { discussionId: $discussionId, body: $body }) {
    discussion {
      id
      url
      body
    }
  }
}`;

const CREATE_DISCUSSION_COMMENT_MUTATION = `mutation addDiscussionComment($discussionId: ID!, $body: String!) {
  addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
    comment {
      id
      url
      body
    }
  }
}`;

const UPDATE_DISCUSSION_COMMENT_MUTATION = `mutation updateDiscussionComment($commentId: ID!, $body: String!) {
  updateDiscussionComment(input: { commentId: $commentId, body: $body }) {
    comment {
      id
      url
      body
    }
  }
}`;

const DELETE_DISCUSSION_COMMENT_MUTATION = `mutation deleteDiscussionComment($commentId: ID!) {
  deleteDiscussionComment(input: { id: $commentId }) {
    comment {
      id
      url
      body
    }
  }
}`;

const REPO_INFO_QUERY = `query repository($owner: String!, $repo: String!, $category: String!) {
  repository(owner: $owner, name: $repo) {
    id

    discussionCategory(slug: $category) {
      id
      name
      slug
    }
  }
}`;

async function main() {
  try {
    const isDeleteRequest = github.context.payload.action === 'deleted';
    const release = github.context.payload.release;
    const isPrivate = github.context.payload.repository.private;
    const releaseDate = new Date(github.context.payload.release.published_at); 

    if (release.draft) return;

    const repository = await graphql(REPO_INFO_QUERY, { owner, repo, category: categorySlug }).then(x => x.repository);
    const category = repository.discussionCategory;
    
    if (!category) {
      core.setFailed(`Category "${categorySlug}" not found, please ensure the category slug is correct.`);
      process.exit(1);
    }

    const cycleName = new Date(releaseDate.getFullYear(), releaseDate.getMonth(), 1).toISOString().substring(0, 7);
    const from = new Date(releaseDate.getFullYear(), releaseDate.getMonth(), 1).toISOString().substring(0, 10);
    const to = new Date(releaseDate.getFullYear(), releaseDate.getMonth() + 1, 1).toISOString().substring(0, 10);
    const cycleIdentifier = `<!-- release-cycle:${cycleName} -->`;

    // note, the github api doens't search for the exact string, we need to filter the results
    let qry = `repo:${full_name} created:>=${from} created:<${to} in:body ${JSON.stringify(cycleIdentifier)}`;
    if (category) qry += ` category:${JSON.stringify(category.name)}`;

    const searchResult = await graphql(SEARCH_QUERY, { qry });
    let discussion = searchResult.search.nodes.find(node => node.body.includes(cycleIdentifier));

    if (discussion) {
      core.info(`Using discussion ${discussion.title} - ${discussion.url}`);
    } else {
      core.info(`Discussion not found, creating new discussion for "${cycleName}"`);

      // create the discussion, as non was found
      const result = await graphql(CREATE_DISCUSSION_MUTATION, {
        repositoryId: String(repository.id),
        categoryId: String(category.id),
        title: `Releases - ${currentYear} ${currentMonth}`,
        body: `${cycleIdentifier}\n\n<!-- START-RELEASE-TOC -->\n<!-- END-RELEASE-TOC -->`,
      });

      discussion = result.createDiscussion.discussion;
      core.info(`Created discussion ${discussion.title} - ${discussion.url}`);
    }

    const releaseName = `${release.name}@${release.tag_name}`;
    const releaseIdentifier = `<!-- release-item:${releaseName} -->`;
    let comments = [];
    let pageInfo;

    do {
      // collect all comments for the discussion, we'll search for the release comment, but also use them to rebuild the TOC
      const result = await graphql(DISCUSSION_BY_ID_QUERY, { id: discussion.id, after: pageInfo?.endCursor });
      comments.push(...result.node.comments.nodes);
      pageInfo = result.node.comments.pageInfo;
    } while (pageInfo.hasNextPage)
  
    let comment = comments.find(node => node.body.includes(releaseIdentifier));
    const title = isPrivate ? releaseName : `[${releaseName}](${release.html_url})`;
    const body = `${releaseIdentifier}\n\n### ${title}\n\n${release.body}`;

    if (isDeleteRequest && comment) {
      comments = comments.filter(x => x.id !== comment.id);
      await graphql(DELETE_DISCUSSION_COMMENT_MUTATION, { commentId: comment.id });
      core.info(`Deleted comment ${releaseName} - ${comment.url}`);
    } else if (isDeleteRequest) {
      core.info(`Comment for ${releaseName} not found, nothing to delete.`)
    } else if (comment) {
      // update existing comment with updated release info
      comment = await graphql(UPDATE_DISCUSSION_COMMENT_MUTATION, {
        commentId: comment.id,
        body,
      }).then(x => x.updateDiscussionComment.comment);
      core.info(`Updated comment ${releaseName} - ${comment.url}`);
    } else {
      // create new comment with release info
      comment = await graphql(CREATE_DISCUSSION_COMMENT_MUTATION, {
        discussionId: discussion.id,
        body,
      }).then(x => x.addDiscussionComment.comment);
      core.info(`Created comment ${releaseName} - ${comment.url}`);
    }

    // TODO: update TOC
    const releases = {};

    for (const comment of comments) {
      const match = comment.body.match(/release-item:(.*?)@(v[\d.]+)/);
      if (!match) continue;

      const name = match[1].trim();
      const version = match[2].trim();

      releases[name] ??= [];
      releases[name].push({
        id: comment.id,
        name,
        version,
        url: comment.url,
      });
    }

    let toc = ['**Releases**\n'];

    for (const name of Object.keys(releases).sort()) {
      for (const release of releases[name]) {
        toc.push(`- [**${release.name}**: ${release.version}](${release.url})`);
      }
    }
    
    toc = toc.join("\n").trim();
    const newBody = discussion.body
      .replace(/(<!-- START-RELEASE-TOC -->)[\s\S]*?(<!-- END-RELEASE-TOC -->)/, `$1\n${toc}\n$2`);
 
    if (newBody !== discussion.body) {
      await graphql(UPDATE_DISCUSSION_MUTATION, {
        discussionId: discussion.id,
        body: newBody,
      });
      core.info(`Updated TOC in discussion ${discussion.url}`);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

main();