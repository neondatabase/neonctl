import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yargs from 'yargs';
import axios, { isAxiosError } from 'axios';

import { retryOnLock } from '../api.js';
import { BranchScopeProps } from '../types.js';
import { branchIdFromProps, fillSingleProject } from '../utils/enrichers.js';
import { log } from '../log.js';
import { writer } from '../writer.js';
import {
  type BucketAccessLevel,
  createProjectBranchBucket,
  listProjectBranchBuckets,
  deleteProjectBranchBucket,
  listProjectBranchBucketObjects,
  getProjectBranchBucketObject,
  deleteProjectBranchBucketObject,
  deleteProjectBranchBucketObjectsByPrefix,
  presignUpload,
} from '../storage_api.js';

const OBJECT_FIELDS = ['key', 'size', 'last_modified', 'etag'] as const;
const BUCKET_FIELDS = ['name', 'access_level'] as const;
const ACCESS_LEVELS = ['private', 'public_read'] as const;

// Single-PUT upload cap. Objects larger than this must use multipart upload,
// which is out of scope for v1; we reject them client-side before any HTTP so
// the user gets an immediate, clear error rather than a server-side rejection
// part-way through a large transfer.
const MAX_OBJECT_BYTES = 100 * 1024 * 1024; // 100 MB

// Ambient scope shared by every bucket sub-command. The bucket name (and the
// object key/prefix) is always a positional, never a flag.
const scopeOptions = {
  'project-id': {
    describe: 'Project ID',
    type: 'string',
  },
  branch: {
    describe: 'Branch ID or name',
    type: 'string',
  },
} as const;

// Split an object target into its bucket and the remainder (key or prefix) on
// the FIRST `/`. Bucket names are DNS-safe so they never contain a slash; the
// remainder may contain further slashes and is returned verbatim. When the
// target has no slash, `rest` is the empty string.
export const splitBucketTarget = (
  target: string,
): { bucket: string; rest: string } => {
  const slash = target.indexOf('/');
  if (slash === -1) {
    return { bucket: target, rest: '' };
  }
  return {
    bucket: target.slice(0, slash),
    rest: target.slice(slash + 1),
  };
};

export const command = 'bucket';
export const describe =
  'Manage branch object-storage buckets and their objects';
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 bucket <sub-command> [options]')
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
      },
    })
    .middleware(fillSingleProject as any)
    .command(
      'create <name>',
      'Create a bucket on a branch',
      (yargs) =>
        yargs
          .usage('$0 bucket create <name> [options]')
          .positional('name', {
            describe: 'The bucket name to create',
            type: 'string',
            demandOption: true,
          })
          .options({
            ...scopeOptions,
            'access-level': {
              describe: 'The visibility of the bucket',
              type: 'string',
              choices: ACCESS_LEVELS,
              default: 'private',
            },
          }),
      (args) => createBucket(args as any),
    )
    .command({
      command: 'list',
      aliases: ['ls'],
      describe: 'List the buckets on a branch',
      builder: (yargs) =>
        yargs.usage('$0 bucket list [options]').options(scopeOptions),
      handler: (args) => listBuckets(args as any),
    })
    .command({
      command: 'delete <name>',
      aliases: ['rm'],
      describe: 'Delete a bucket from a branch',
      builder: (yargs) =>
        yargs
          .usage('$0 bucket delete <name> [options]')
          .positional('name', {
            describe: 'The bucket name to delete',
            type: 'string',
            demandOption: true,
          })
          .options(scopeOptions),
      handler: (args) => deleteBucket(args as any),
    })
    .command(
      'object <sub-command>',
      'List, download, upload or delete objects in a bucket',
      (yargs) =>
        yargs
          .usage('$0 bucket object <sub-command> [options]')
          .command({
            command: 'list <target>',
            aliases: ['ls'],
            describe: 'List objects in a bucket',
            builder: (yargs) =>
              yargs
                .usage('$0 bucket object list <bucket>[/<prefix>] [options]')
                .positional('target', {
                  describe:
                    'The bucket to list, optionally with a key prefix: <bucket>[/<prefix>]',
                  type: 'string',
                  demandOption: true,
                })
                .options({
                  ...scopeOptions,
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
            handler: (args) => listObjects(args as any),
          })
          .command(
            'get <target>',
            'Download an object from a bucket to a local file',
            (yargs) =>
              yargs
                .usage('$0 bucket object get <bucket>/<key> [options]')
                .positional('target', {
                  describe: 'The object to download: <bucket>/<key>',
                  type: 'string',
                  demandOption: true,
                })
                .options({
                  ...scopeOptions,
                  file: {
                    describe:
                      'Path to write the downloaded object to (defaults to the object filename in the current directory)',
                    type: 'string',
                  },
                }),
            (args) => getObject(args as any),
          )
          .command(
            'put <target>',
            'Upload a local file to a bucket as an object',
            (yargs) =>
              yargs
                .usage('$0 bucket object put <bucket>/<key> [options]')
                .positional('target', {
                  describe: 'The object to upload to: <bucket>/<key>',
                  type: 'string',
                  demandOption: true,
                })
                .options({
                  ...scopeOptions,
                  file: {
                    describe: 'Path to the local file to upload',
                    type: 'string',
                    demandOption: true,
                  },
                  'content-type': {
                    describe:
                      'Content-Type to store the object with (e.g. text/plain)',
                    type: 'string',
                  },
                }),
            (args) => putObject(args as any),
          )
          .command({
            command: 'delete <target>',
            aliases: ['rm'],
            describe: 'Delete an object, or every object under a prefix',
            builder: (yargs) =>
              yargs
                .usage('$0 bucket object delete <bucket>/<key> [options]')
                .positional('target', {
                  describe:
                    'The object to delete: <bucket>/<key>, or <bucket>/<prefix>/ with --recursive',
                  type: 'string',
                  demandOption: true,
                })
                .options({
                  ...scopeOptions,
                  recursive: {
                    describe:
                      'Delete every object under the given prefix. The prefix must end with "/"',
                    type: 'boolean',
                    default: false,
                  },
                }),
            handler: (args) => deleteObject(args as any),
          })
          .demandCommand(1, '')
          .strictCommands(),
    )
    .demandCommand(1, '');

export const handler = (args: yargs.Argv) => {
  return args;
};

const createBucket = async (
  props: BranchScopeProps & { name: string; accessLevel: BucketAccessLevel },
): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  const { data } = await retryOnLock(() =>
    createProjectBranchBucket(props.apiClient, {
      projectId: props.projectId,
      branchId,
      name: props.name,
      accessLevel: props.accessLevel,
    }),
  );
  log.info(
    `Bucket "${data.bucket.name}" (${data.bucket.access_level}) created on branch ${branchId}`,
  );
};

const listBuckets = async (props: BranchScopeProps): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  const { data } = await listProjectBranchBuckets(props.apiClient, {
    projectId: props.projectId,
    branchId,
  });

  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end(data.buckets, { fields: BUCKET_FIELDS });
    return;
  }

  writer(props).end(data.buckets, {
    fields: BUCKET_FIELDS,
    title: 'buckets',
    emptyMessage: 'No buckets found.',
  });
};

const deleteBucket = async (
  props: BranchScopeProps & { name: string },
): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  try {
    await retryOnLock(() =>
      deleteProjectBranchBucket(props.apiClient, {
        projectId: props.projectId,
        branchId,
        bucketName: props.name,
      }),
    );
  } catch (err: unknown) {
    if (isAxiosError(err) && err.response?.status === 404) {
      throw new Error(
        `Bucket "${props.name}" not found on branch ${branchId}.`,
      );
    }
    throw err;
  }
  log.info(`Bucket "${props.name}" deleted from branch ${branchId}`);
};

const listObjects = async (
  props: BranchScopeProps & {
    target: string;
    delimiter?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  const { bucket, rest } = splitBucketTarget(props.target);
  const { data } = await listProjectBranchBucketObjects(props.apiClient, {
    projectId: props.projectId,
    branchId,
    bucketName: bucket,
    prefix: rest === '' ? undefined : rest,
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

// Pull a filename out of a `Content-Disposition` header, falling back to the
// last segment of the object key. Handles the plain and RFC 5987 (`filename*=`)
// forms the download endpoint may emit.
const filenameFromContentDisposition = (
  contentDisposition: string | undefined,
  key: string,
): string => {
  if (contentDisposition) {
    const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(contentDisposition);
    if (extended?.[1]) {
      try {
        return basename(decodeURIComponent(extended[1].trim()));
      } catch {
        // Fall through to the plain form / key on malformed encoding.
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(contentDisposition);
    if (plain?.[1]) {
      return basename(plain[1].trim());
    }
  }
  return basename(key) || key;
};

// Pull the `message` field out of a server error body, returning undefined when
// the body is absent, not an object, or carries no usable message.
const serverErrorMessage = (body: unknown): string | undefined => {
  const message = (body as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.trim() !== ''
    ? message
    : undefined;
};

// Drain a streamed error body (the form an `octet-stream` download 404 takes)
// and parse its `message`. Returns undefined on any read/parse failure so the
// caller falls back to its default message.
const streamErrorMessage = async (
  stream: unknown,
): Promise<string | undefined> => {
  if (
    typeof (stream as { [Symbol.asyncIterator]?: unknown })?.[
      Symbol.asyncIterator
    ] !== 'function'
  ) {
    return undefined;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.from(chunk));
    }
    return serverErrorMessage(JSON.parse(Buffer.concat(chunks).toString()));
  } catch {
    return undefined;
  }
};

const objectNotFoundFallback = (
  key: string,
  bucket: string,
  branchId: string,
): string =>
  `Object "${key}" not found in bucket "${bucket}" on branch ${branchId}.`;

// Prefer the server's error message when present so a missing bucket is not
// misreported as a missing object; otherwise fall back to a clean default. Used
// for the JSON (non-streamed) endpoints where the body is already parsed.
const objectNotFoundMessage = (
  err: unknown,
  key: string,
  bucket: string,
  branchId: string,
): string => {
  if (isAxiosError(err)) {
    const serverMessage = serverErrorMessage(err.response?.data);
    if (serverMessage !== undefined) {
      return serverMessage;
    }
  }
  return objectNotFoundFallback(key, bucket, branchId);
};

const getObject = async (
  props: BranchScopeProps & { target: string; file?: string },
): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  const { bucket, rest: key } = splitBucketTarget(props.target);
  if (key === '') {
    throw new Error('Object target must be in the form <bucket>/<key>.');
  }

  let response;
  try {
    response = await getProjectBranchBucketObject(props.apiClient, {
      projectId: props.projectId,
      branchId,
      bucketName: bucket,
      objectKey: key,
    });
  } catch (err: unknown) {
    if (isAxiosError(err) && err.response?.status === 404) {
      // The download response is a stream, so a 404 body arrives as a stream
      // too; drain and parse it to recover the server's message (which
      // distinguishes a missing bucket from a missing object).
      const serverMessage = await streamErrorMessage(err.response.data);
      throw new Error(
        serverMessage ?? objectNotFoundFallback(key, bucket, branchId),
      );
    }
    throw err;
  }

  const contentDisposition = response.headers['content-disposition'] as
    | string
    | undefined;
  const destination =
    props.file ?? filenameFromContentDisposition(contentDisposition, key);

  try {
    await pipeline(response.data, createWriteStream(destination));
  } catch (err: unknown) {
    // Best-effort cleanup of the partial file before rethrowing.
    await unlink(destination).catch(() => undefined);
    throw err;
  }
  log.info(
    `Object "${key}" downloaded from bucket "${bucket}" on branch ${branchId} to ${destination}`,
  );
};

const putObject = async (
  props: BranchScopeProps & {
    target: string;
    file: string;
    contentType?: string;
  },
): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  const { bucket, rest: key } = splitBucketTarget(props.target);
  if (bucket === '' || key === '') {
    throw new Error('Object target must be in the form <bucket>/<key>.');
  }

  // Stat the file first so we fail fast on a missing/unreadable file and can
  // enforce the single-PUT size cap BEFORE any network round-trip. We also
  // reuse the byte count as the PUT Content-Length so the stream is uploaded
  // without buffering the whole file in memory.
  let fileSize: number;
  try {
    const fileStat = await stat(props.file);
    if (!fileStat.isFile()) {
      throw new Error(`"${props.file}" is not a regular file.`);
    }
    fileSize = fileStat.size;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`File "${props.file}" does not exist.`);
    }
    throw err;
  }

  if (fileSize > MAX_OBJECT_BYTES) {
    throw new Error(
      `File "${props.file}" is ${fileSize} bytes, which exceeds the ${MAX_OBJECT_BYTES}-byte (100 MB) single-upload limit. Larger objects are not supported yet.`,
    );
  }

  // Ask the console for a presigned PUT URL plus the headers that must travel
  // with the upload for the signature to verify. No SigV4 happens in neonctl.
  let presign;
  try {
    ({ data: presign } = await presignUpload(props.apiClient, {
      projectId: props.projectId,
      branchId,
      bucketName: bucket,
      objectKey: key,
      contentType: props.contentType,
    }));
  } catch (err: unknown) {
    if (isAxiosError(err) && err.response?.status === 404) {
      throw new Error(objectNotFoundMessage(err, key, bucket, branchId));
    }
    throw err;
  }

  // Stream the file straight into the PUT body; never buffer the whole file.
  // The presigned URL targets the branch S3 data-plane endpoint directly, so
  // this PUT goes through a plain axios call rather than the console api-client.
  //
  // `presign.headers` carries the signature-relevant headers (e.g. host,
  // content-type); the server does not sign Content-Length, so we set it
  // ourselves from the stat'd size to keep the upload streamed, not chunked.
  // `maxRedirects: 0` ensures we never resend the file bytes and signed headers
  // to a different host if the data-plane endpoint were to answer with a
  // redirect.
  try {
    await axios.put(presign.url, createReadStream(props.file), {
      headers: {
        ...presign.headers,
        'Content-Length': fileSize,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      maxRedirects: 0,
    });
  } catch (err: unknown) {
    // The upload targets the S3 data plane, whose error bodies are XML rather
    // than the JSON `{ message }` the console returns, so surface the status
    // (and axios message) rather than leaking a raw error. Never include the
    // presigned URL, which carries the signature.
    if (isAxiosError(err)) {
      const status = err.response?.status;
      throw new Error(
        `Failed to upload "${props.file}" to "${key}" in bucket "${bucket}" on branch ${branchId}${
          status !== undefined ? ` (HTTP ${status})` : ''
        }: ${err.message}`,
      );
    }
    throw err;
  }

  log.info(
    `File "${props.file}" uploaded to "${key}" in bucket "${bucket}" on branch ${branchId}`,
  );
};

const deleteObject = async (
  props: BranchScopeProps & { target: string; recursive: boolean },
): Promise<void> => {
  const branchId = await branchIdFromProps(props);
  const { bucket, rest } = splitBucketTarget(props.target);

  if (props.recursive) {
    if (rest === '') {
      throw new Error(
        'Recursive delete requires a non-empty prefix ending in "/".',
      );
    }
    if (!rest.endsWith('/')) {
      throw new Error(
        `Recursive delete requires a prefix ending in "/" (got "${rest}").`,
      );
    }
    const { data } = await retryOnLock(() =>
      deleteProjectBranchBucketObjectsByPrefix(props.apiClient, {
        projectId: props.projectId,
        branchId,
        bucketName: bucket,
        prefix: rest,
      }),
    );
    log.info(
      `Deleted ${data.deleted} object(s) under prefix "${rest}" from bucket "${bucket}" on branch ${branchId}`,
    );
    return;
  }

  if (rest === '') {
    throw new Error('Object target must be in the form <bucket>/<key>.');
  }

  try {
    await retryOnLock(() =>
      deleteProjectBranchBucketObject(props.apiClient, {
        projectId: props.projectId,
        branchId,
        bucketName: bucket,
        objectKey: rest,
      }),
    );
  } catch (err: unknown) {
    if (isAxiosError(err) && err.response?.status === 404) {
      throw new Error(objectNotFoundMessage(err, rest, bucket, branchId));
    }
    throw err;
  }
  log.info(
    `Object "${rest}" deleted from bucket "${bucket}" on branch ${branchId}`,
  );
};
