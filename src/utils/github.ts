import { Octokit } from 'octokit';
import axios from 'axios';
import pLimit from 'p-limit';

import { log } from '../log.js';

import path from 'path';
import fs from 'fs';

const CONCURRENT_OPERATIONS_LIMIT = 10;

export async function getContent({
  owner,
  repository,
}: {
  owner: string;
  repository: string;
}) {
  const octokit = new Octokit({});
  return (
    await octokit.rest.repos.getContent({
      owner: owner,
      repo: repository,
    })
  ).data;
}

export function getFileContentUrl(
  owner: string,
  repository: string,
  path: string,
) {
  return (
    'https://raw.githubusercontent.com/' +
    owner +
    '/' +
    repository +
    '/main/' +
    path
  );
}

export async function getFileContent(
  owner: string,
  repository: string,
  path: string,
) {
  const url = getFileContentUrl(owner, repository, path);

  return await fetch(url, { method: 'Get' });
}

export async function getBranchSHA(
  owner: string,
  repo: string,
  branch: string,
) {
  const branchUrl = `https://api.github.com/repos/${owner}/${repo}/branches/${branch}`;
  const response = await axios.get(branchUrl, {
    headers: { Accept: 'application/vnd.github.v3+json' },
  });
  return response.data.commit.sha;
}

export async function getRepoTree(owner: string, repo: string, sha: string) {
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`;
  const response = await axios.get(treeUrl, {
    headers: { Accept: 'application/vnd.github.v3+json' },
  });
  return response.data.tree;
}

export async function downloadFolderFromTree(
  owner: string,
  repo: string,
  branch: string,
  folderPath: string,
  destination: string,
) {
  try {
    const sha = await getBranchSHA(owner, repo, branch);

    const tree = await getRepoTree(owner, repo, sha);

    const folderTree = tree.filter(
      (item: any) => item.path.startsWith(folderPath) && item.type === 'blob',
    );

    for (const file of folderTree) {
      const savePath = path.join(
        destination,
        file.path.replace(folderPath, ''),
      );
      const fileDir = path.dirname(savePath);
      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
      }
    }

    const limit = pLimit(CONCURRENT_OPERATIONS_LIMIT);

    const downloadPromises = folderTree.map((file: any) => {
      const filePath = file.path;
      const savePath = path.join(destination, filePath.replace(folderPath, ''));
      const fileUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;

      return limit(() =>
        downloadFile(fileUrl, savePath)
          .then(() => {
            log.debug(`Downloaded ${filePath}`);
          })
          .catch((err: unknown) => {
            let errorMessage = `Error downloading ${filePath}`;
            if (err instanceof Error) {
              errorMessage += ': ' + err.message;
            }
            log.error(errorMessage);
          }),
      );
    });

    await Promise.all(downloadPromises);

    log.info('All files downloaded successfully.');
  } catch (error: any) {
    log.error('Error downloading folder:', error.message);
  }
}

export async function downloadFile(url: string, savePath: string) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });
  const writer = fs.createWriteStream(savePath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}
