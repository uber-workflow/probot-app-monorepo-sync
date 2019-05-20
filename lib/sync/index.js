/** Copyright (c) 2019 Uber Technologies, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {request} from '../github.js';
import {getPRsFromBranch, getPRFromNumber, getRef} from '../graphql.js';
import {
  getChild,
  getChildren,
  getParentName,
  getRelatedRepoNames,
  getRelationship,
  hasChildren,
  hasParent,
  hasRelationship,
} from '../relationships.js';
import {sequential} from '../utils.js';
import {copyCommits} from './commits.js';
import {syncPRStatuses} from './commit-status.js';

const BOT_SIGNATURE =
  '\n\n<sup>Generated by [probot-app-monorepo-sync](https://github.com/uber-workflow/probot-app-monorepo-sync)</sup>';

/**
 * @typedef {{
 *   number: number,
 *   repoName: string,
 * }} PROptType
 */

/**
 * @param {string} body
 * @returns {object}
 */
// this is messy, but I wanted it to be really forgiving on
// whitespace/formatting; maybe cleanup sometime
export function parsePRBodyMeta(body) {
  const result = {};

  for (const comment of body.replace(/\r\n|\r/g, '\n').split('<!--')) {
    if (comment.includes('meta:')) {
      const lines = comment
        .split('\n')
        .filter(line => line && !/^ *#/.test(line));
      let currentKey, buffer;

      for (let line of lines) {
        line = line.trim();
        if (line.startsWith('meta:')) continue;

        const hasTerminator = line.includes('-->');
        line = line.replace('-->', '');

        if (line) {
          if (/^\w+ *:/.test(line)) {
            const [, key, content] = /(\w+) *: *(.+)/.exec(line);

            if (currentKey && buffer) {
              result[currentKey] = buffer;
            }

            currentKey = key;
            buffer = content ? content : '';
          } else {
            buffer += '\n' + line;
          }
        }

        if (hasTerminator) break;
      }

      if (buffer) result[currentKey] = buffer;
      break;
    }
  }

  return result;
}

/**
 * @param {string} message
 * @returns {object}
 */
export function parseCommitMeta(message) {
  const result = {};

  for (const line of message.split('\n')) {
    if (line.startsWith('meta:')) {
      const props = line
        .trim()
        .replace(/^meta:/, '')
        .split(';');

      for (const prop of props) {
        const [key, value] = prop.split(':');
        // default to true if no value
        result[key] = value || true;
      }
    }
  }

  return result;
}

/**
 * @param {PROptType} pullRequest
 * @returns {string}
 */
export function generateSecondaryBranchName(pullRequest) {
  return [pullRequest.repoName, pullRequest.number].join('/');
}

/**
 * @param {string} branchName
 * @returns {boolean}
 */
export function isSecondaryBranchName(branchName) {
  return /\w+\/\w+\/\d+/.test(branchName);
}

/**
 * @param {string} branchName
 * @returns {PROptType}
 */
export function parseSecondaryBranchName(branchName) {
  const [owner, repo, number] = branchName.split('/');
  return {
    number: parseInt(number),
    repoName: [owner, repo].join('/'),
  };
}

/**
 * @param {PROptType} pullRequest
 * @returns {Promise<PROptType & {
 *   role: 'primary' | 'secondary',
 * } | void>}
 */
export async function getPartnerPR(pullRequest) {
  const branchName = await getPRFromNumber(
    '{headRefName}',
    pullRequest,
    'repository.pullRequest.headRefName',
  );

  if (isSecondaryBranchName(branchName)) {
    const {
      number: partnerNumber,
      repoName: partnerRepoName,
    } = parseSecondaryBranchName(branchName);
    const partnerPr = await getPRFromNumber(
      '{number}',
      {number: partnerNumber, repoName: partnerRepoName},
      'repository.pullRequest',
    );

    if (partnerPr) {
      return {
        number: partnerNumber,
        repoName: partnerRepoName,
        role: 'primary',
      };
    }
  }

  const secondaryBranchName = generateSecondaryBranchName(pullRequest);

  for (const partnerRepoName of getRelatedRepoNames(pullRequest.repoName)) {
    const partnerNumber = await getPRsFromBranch(
      '{number}',
      {branchName: secondaryBranchName, repoName: partnerRepoName},
      'repository.pullRequests.nodes.0.number',
    );

    if (partnerNumber) {
      return {
        number: partnerNumber,
        repoName: partnerRepoName,
        role: 'secondary',
      };
    }
  }
}

/**
 * @param {PROptType} pullRequest
 * @returns {Promise<string | void>} repoName
 */
export async function getSecondaryCandidate(pullRequest) {
  const {repoName} = pullRequest;

  if (hasParent(repoName)) {
    return getParentName(repoName);
  } else if (hasChildren(repoName)) {
    const changedFiles = await getPRFromNumber(
      // TODO: handle pagination to support PRs with more than 100 changed files
      '{files(first: 100) {nodes {path}}}',
      pullRequest,
      'repository.pullRequest.files.nodes',
    );

    for (const child of getChildren(repoName)) {
      const hasChildFiles = changedFiles.some(file =>
        file.path.startsWith(child.path),
      );

      if (hasChildFiles) {
        return child.name;
      }
    }
  }
}

/**
 * @param {PROptType} primaryPR
 * @param {string} secondaryRepoName
 * @returns {Promise<void>}
 */
async function createSecondaryPR(primaryPR, secondaryRepoName) {
  const secondaryBranchName = generateSecondaryBranchName(primaryPR);
  const repoRelation = getRelationship(primaryPR.repoName, secondaryRepoName);
  const primaryPRInfo = await getPRFromNumber(
    '{baseRefName, baseRefOid, body, headRefOid, title}',
    primaryPR,
    'repository.pullRequest',
  );
  const secondaryBaseRefOid = await getRef(
    '{target {oid}}',
    {name: primaryPRInfo.baseRefName, repoName: secondaryRepoName},
    'repository.ref.target.oid',
  );

  if (secondaryBaseRefOid) {
    await sequential([
      // create branch
      async () =>
        request('POST /repos/:repoName/git/refs', {
          repoName: secondaryRepoName,
          data: {
            ref: `refs/heads/${secondaryBranchName}`,
            sha: secondaryBaseRefOid,
          },
        }),
      // copy commits
      async () => {
        const opts = {
          source: {
            afterSha: primaryPRInfo.headRefOid,
            beforeSha: primaryPRInfo.baseRefOid,
            repoName: primaryPR.repoName,
          },
          target: {
            branch: secondaryBranchName,
            repoName: secondaryRepoName,
            sha: secondaryBaseRefOid,
          },
        };

        if (repoRelation === 'parent') {
          opts.source.subPath = getChild(
            primaryPR.repoName,
            secondaryRepoName,
          ).path;
        } else if (repoRelation === 'child') {
          opts.target.subPath = getChild(
            secondaryRepoName,
            primaryPR.repoName,
          ).path;
        }

        return copyCommits(opts);
      },
      // create PR
      async () => {
        let body, title;

        if (repoRelation === 'parent') {
          const meta = parsePRBodyMeta(primaryPRInfo.body);

          if (meta.publicTitle === 'MATCH') {
            title = primaryPRInfo.title;
          } else if (meta.publicTitle) {
            title = meta.publicTitle;
          } else {
            // this is really just a safety net in case someone forgets to provide the meta
            title = 'Sync pull request from parent repo';
          }

          body = (meta.publicBody || '').replace(/\\\\n/g, '\\n');
        } else if (repoRelation === 'child') {
          title = primaryPRInfo.title;
          body =
            `This PR was generated automatically to sync changes from ${
              primaryPR.repoName
            }#${
              primaryPR.number
            }.\n\nIf any supplemental changes are needed in this repo, please make them here by pushing to the \`${secondaryBranchName}\` branch.` +
            BOT_SIGNATURE;
        }

        return request('POST /repos/:repoName/pulls', {
          repoName: secondaryRepoName,
          data: {
            title,
            head: secondaryBranchName,
            base: primaryPRInfo.baseRefName,
            body: body,
            maintainer_can_modify: true,
          },
        });
      },
      async res => {
        if (repoRelation === 'parent') {
          return request('POST /repos/:repoName/issues/:number/comments', {
            number: primaryPR.number,
            repoName: primaryPR.repoName,
            data: {
              body:
                `Looks like this PR modified files in the \`${
                  getChild(primaryPR.repoName, secondaryRepoName).path
                }\` directory.\n\nA secondary PR has been opened at ${secondaryRepoName}#${
                  res.data.number
                } and will be kept in sync automatically. To update its title or body, edit \`meta.publicTitle\` and \`meta.publicBody\` in the body of this PR.` +
                BOT_SIGNATURE,
            },
          });
        }
      },
    ]);
  }
}

async function syncCommits() {
  // add partner sha to commit message
  // mark private-only commits so they're skipped when comparing partners
}

async function syncMerge() {
  // if only one if merged, merge the other
}

async function syncOpenState() {
  // use `pull_request.closed_at` timestamp to determine which to use
  // if one is closed, and `closed_at` is after `updated_at` of other, close
  // if no more child files changed, close secondary pr
}

async function syncTitleAndBody() {
  // use meta if parent repo
}

/**
 * @param {SyncPROptsType} opts
 * @returns {Promise<number | void>}
 */
async function getPRNumberFromOpts(opts) {
  let {number: result} = opts;

  if (!result) {
    const {repoName} = opts;
    const branchNames = opts.branchNames || [opts.branchName];

    for (const branchName of branchNames) {
      result = await getPRsFromBranch(
        '{number}',
        {branchName, repoName},
        'repository.pullRequests.nodes.0.number',
      ).then(res => res.length && res[0]);

      if (result) break;
    }
  }

  return result;
}

/**
 * @typedef {{
 *   branchName?: string,
 *   branchNames?: string[],
 *   number?: number,
 *   repoName: string,
 * }} SyncPROptsType
 *
 * @param {SyncPROptsType} opts
 * @returns {Promise<void>}
 */
// TODO: use queue for each pr to make sure one sync is happening at a time
// TODO: should it be queue for pr and its partner, or just each pr?
export async function syncPR(opts) {
  const {repoName} = opts;

  if (hasRelationship(repoName)) {
    const number = await getPRNumberFromOpts(opts);

    if (number) {
      const pullRequest = {number, repoName};
      const partnerPR = await getPartnerPR(pullRequest);

      if (partnerPR) {
        let primaryPR, secondaryPR;

        if (partnerPR.role === 'primary') {
          primaryPR = partnerPR;
          secondaryPR = pullRequest;
        } else {
          primaryPR = pullRequest;
          secondaryPR = partnerPR;
        }

        delete partnerPR.role;
        await sequential([
          () => syncPRStatuses(primaryPR, secondaryPR),
          () => syncMerge(),
          async isMerged => (isMerged ? true : syncOpenState()),
          async isOpen => {
            if (isOpen) {
              await syncCommits();
            }

            return isOpen;
          },
          isOpen => isOpen && syncTitleAndBody(),
        ]);
      } else {
        const secondaryCandidateName = await getSecondaryCandidate(pullRequest);

        if (secondaryCandidateName) {
          await createSecondaryPR(pullRequest, secondaryCandidateName);
        }
      }
    }
  }
}