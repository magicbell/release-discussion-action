import * as github from '@actions/github';
import * as core from "@actions/core";

import type { Discussion, DiscussionComment, Query, Mutation, Repository } from '@octokit/graphql-schema';
import invariant from 'tiny-invariant';

const token = process.env.GITHUB_TOKEN;

invariant(token, 'GITHUB_TOKEN is required');

const octokit = github.getOctokit(token);
const graphql = octokit.graphql.defaults({
  headers: {
    authorization: `bearer ${token}`,
  }
});

export async function searchDiscussions({ repo, from, to, search, category }: { repo: string, from: Date, to: Date, search: string, category: string }) {
  // note, the github api doesn't search for the exact string, we need to filter the results
  let qry = `in:body ${JSON.stringify(search)}`;
  if (repo) qry += ` repo:${repo}`;
  if (from) qry += ` created:>=${from.toISOString().substring(0, 10)}`;
  if (to) qry += ` created:<${to.toISOString().substring(0, 10)}`;
  if (category) qry += ` category:${JSON.stringify(category)}`;

  core.debug(`searching for discussions: ${qry}`);

  // note: octokit does not support variables named `query`
  const query = `query search($qry: String!) {
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

  const result = await graphql<{ search: Query['search'] }>(query, { qry });
  return result.search.nodes as Array<Pick<Discussion, 'id' | 'title' | 'body' | 'url'>>;
}

export async function getDiscussionById(variables: { discussionId: String }) {
  core.debug(`get discussion by id: ${variables.discussionId}`);

  const query = `query node($discussionId: ID!, $first: Int = 100, $after: String) {
    node(id: $discussionId) {
      ...on Discussion {
        id
        title
        body
        url

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

  let comments: Array<DiscussionComment> = [];
  let pageInfo;
  let discussion: Discussion | null = null;

  do {
    // collect all comments for the discussion
    const vars = { discussionId: variables.discussionId, after: pageInfo?.endCursor };
    const result = await graphql<{ node: Discussion }>(query, vars);

    // @ts-expect-error comments is not null
    comments.push(...result.node.comments.nodes);
    pageInfo = result.node.comments.pageInfo;
    discussion = result.node;
  } while (pageInfo.hasNextPage)

  return {
    ...discussion,
    comments,
  } as Pick<Discussion, 'id' | 'title' | 'body' | 'url'> & { comments: Pick<DiscussionComment, 'id' | 'body' | 'url'>[] };
}

export async function deleteDiscussion(variables: { discussionId: string }) {
  const mutation = `mutation ($discussionId: ID!) {
    deleteDiscussion(input: { id: $discussionId }) {
      discussion {
        id
        title
        body
        url
      }
    }
  }`;

  const result = await graphql<{ deleteDiscussion: Mutation['deleteDiscussion'] }>(mutation, variables);
  invariant(result?.deleteDiscussion?.discussion, 'discussion not found');
  return result.deleteDiscussion.discussion as Pick<Discussion, 'id' | 'title' | 'body' | 'url'>;
}

export async function createDiscussion(variables: { repositoryId: string, categoryId: string, title: string, body: string }) {
  const mutation = `mutation createDiscussion($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
    createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) {
      discussion {
        id
        title
        body
        url
      }
    }
  }`;

  const result = await graphql<{ createDiscussion: Mutation['createDiscussion'] }>(mutation, variables);
  invariant(result?.createDiscussion?.discussion, 'discussion not found');
  return result.createDiscussion.discussion as Pick<Discussion, 'id' | 'title' | 'body' | 'url'>;
}


export async function updateDiscussion(variables: { discussionId: string, body: string }) {
  const mutation = `mutation updateDiscussion($discussionId: ID!, $body: String!) {
    updateDiscussion(input: { discussionId: $discussionId, body: $body }) {
      discussion {
        id
        url
        body
      }
    }
  }`;

  const result = await graphql<{ updateDiscussion: Mutation['updateDiscussion'] }>(mutation, variables);
  invariant(result?.updateDiscussion?.discussion, 'discussion not found');
  return result.updateDiscussion.discussion as Pick<Discussion, 'id' | 'url' | 'body'>;
}

export async function addDiscussionComment(variables: { discussionId: string, body: string }) {
  const mutation = `mutation addDiscussionComment($discussionId: ID!, $body: String!) {
    addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
      comment {
        id
        url
        body
      }
    }
  }`;

  const result = await graphql<{ addDiscussionComment: Mutation['addDiscussionComment'] }>(mutation, variables);
  invariant(result?.addDiscussionComment?.comment, 'comment not found')
  return result.addDiscussionComment.comment as Pick<DiscussionComment, 'id' | 'url' | 'body'>;
}

export async function updateDiscussionComment(variables: { commentId: string, body: string }) {
  const mutation = `mutation updateDiscussionComment($commentId: ID!, $body: String!) {
    updateDiscussionComment(input: { commentId: $commentId, body: $body }) {
      comment {
        id
        url
        body
      }
    }
  }`;

  const result = await graphql<{ updateDiscussionComment: Mutation['updateDiscussionComment'] }>(mutation, variables);
  invariant(result?.updateDiscussionComment?.comment, 'comment not found');
  return result.updateDiscussionComment.comment as Pick<DiscussionComment, 'id' | 'url' | 'body'>;
}

export async function deleteDiscussionComment(variables: { commentId: string }) {
  const mutation = `mutation deleteDiscussionComment($commentId: ID!) {
    deleteDiscussionComment(input: { id: $commentId }) {
      comment {
        id
        url
        body
      }
    }
  }`;

  const result = await graphql<{ deleteDiscussionComment: Mutation['deleteDiscussionComment'] }>(mutation, variables);
  invariant(result?.deleteDiscussionComment?.comment, 'comment not found');

  return result.deleteDiscussionComment.comment as Pick<DiscussionComment, 'id' | 'url' | 'body'>;
}

export async function getRepository({ owner, repo, category }: { owner: string, repo: string, category: string }) {
  const query = `query repository($owner: String!, $repo: String!, $category: String!) {
    repository(owner: $owner, name: $repo) {
      id
  
      discussionCategory(slug: $category) {
        id
        name
        slug
      }
    }
  }`;

  const result = await graphql<{ repository: Query['repository'] }>(query, { owner, repo, category });
  return result.repository as Pick<Repository, 'id'> & { discussionCategory: Pick<Discussion['category'], 'id' | 'name' | 'slug'> };
}
