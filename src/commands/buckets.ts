import yargs from 'yargs';
import { isAxiosError } from 'axios';

import { retryOnLock } from '../api.js';
import { BranchScopeProps } from '../types.js';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';
import { log } from '../log.js';
import { writer } from '../writer.js';
import {
  listProjectBranchBucketObjects,
  deleteProjectBranchBucketObject,
} from '../storage_api.js';

type BucketProps = BranchScopeProps & {
  bucket: string;
};

const OBJECT_FIELDS = ['key', 'size', 'last_modified', 'etag'] as const;

const bucketOptions = {
  'project-id': {
    describe: 'Project ID',
    type: 'string',
  },
  branch: {
    describe: 'Branch ID or name',
    type: 'string',
  },
  bucket: {
    describe: 'Bucket name',
    type: 'string',
    demandOption: true,
  },
} as const;

export const command = 'buckets';
export const describe = 'Manage objects in branch object-storage buckets';
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 buckets <sub-command> [options]')
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
      },
    })
    .middleware(fillSingleProject as any)
    .command(
      'objects <sub-command>',
      'List or delete objects in a bucket',
      (yargs) =>
        yargs
          .usage('$0 buckets objects <sub-command> [options]')
          .command(
            'list',
            'List objects in a bucket',
            (yargs) =>
              yargs.options({
                ...bucketOptions,
                prefix: {
                  describe:
                    'Only list objects whose key starts with this prefix',
                  type: 'string',
                },
                delimiter: {
                  describe:
                    'Collapse keys sharing a common prefix (e.g. "/") into folders',
                  type: 'string',
                },
                cursor: {
                  describe:
                    'Pagination cursor returned as next_cursor by a previous call',
                  type: 'string',
                },
                limit: {
                  describe:
                    'Maximum number of items (objects + folders) to return',
                  type: 'number',
                },
              }),
            (args) => list(args as any),
          )
          .command(
            'delete <key>',
            'Delete an object from a bucket',
            (yargs) =>
              yargs
                .usage('$0 buckets objects delete <key> [options]')
                .positional('key', {
                  describe: 'The object key to delete',
                  type: 'string',
                  demandOption: true,
                })
                .options(bucketOptions),
            (args) => deleteObject(args as any),
          )
          .demandCommand(1, '')
          .strictCommands(),
    )
    .demandCommand(1, '');

export const handler = (args: yargs.Argv) => {
  return args;
};

const list = async (
  props: BucketProps & {
    prefix?: string;
    delimiter?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  const { data } = await listProjectBranchBucketObjects(props.apiClient, {
    projectId: props.projectId,
    branchId,
    bucketName: props.bucket,
    prefix: props.prefix,
    delimiter: props.delimiter,
    cursor: props.cursor,
    limit: props.limit,
  });

  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data, {
      fields: ['folders', 'objects', 'prefix', 'next_cursor', 'is_truncated'],
    });
    return;
  }

  const w = writer(props);
  if (data.folders.length > 0) {
    w.write(
      data.folders.map((name) => ({ name })),
      { fields: ['name'], title: 'folders' },
    );
  }
  w.write(data.objects, {
    fields: OBJECT_FIELDS,
    title: 'objects',
    emptyMessage: 'No objects found.',
  });
  w.end();

  if (data.is_truncated && data.next_cursor) {
    log.info(
      `More results available. Re-run with --cursor ${data.next_cursor} to fetch the next page.`,
    );
  }
};

const deleteObject = async (
  props: BucketProps & { key: string },
): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  try {
    await retryOnLock(() =>
      deleteProjectBranchBucketObject(props.apiClient, {
        projectId: props.projectId,
        branchId,
        bucketName: props.bucket,
        objectKey: props.key,
      }),
    );
  } catch (err: unknown) {
    if (isAxiosError(err) && err.response?.status === 404) {
      throw new Error(
        `Object "${props.key}" not found in bucket "${props.bucket}" on branch ${branchId}.`,
      );
    }
    throw err;
  }
  log.info(
    `Object "${props.key}" deleted from bucket "${props.bucket}" on branch ${branchId}`,
  );
};
