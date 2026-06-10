// Typed client helpers for the branch object-storage (bucket/object) API.
//
// These endpoints are part of the Neon object-storage surface (the "Buckets"
// tag in the public API). They are not yet exposed as typed methods on the
// published `@neondatabase/api-client` package, so the request/response types
// and the thin call helpers live here. They are implemented on top of the
// api-client's public `request()` method, which means they reuse the exact
// same authentication, base URL, headers and retry behaviour as every other
// neonctl command. When the generated client gains these methods, the call
// sites in `src/commands/bucket.ts` can switch over with no behavioural
// change.

import { type Readable } from 'node:stream';

import { type Api } from '@neondatabase/api-client';

export type ApiClient = Api<unknown>;

// The api-client bundles its own axios version, whose `AxiosResponse` type is
// not assignable to the one neonctl depends on directly. Callers only ever read
// `.data` (and, for the download helper, `.headers`), so we expose that minimal
// shape and let the helpers return the client's native promise unchanged.
type ApiResponse<T> = { data: T };
type ApiResponseWithHeaders<T> = {
  data: T;
  headers: Record<string, unknown>;
};

/** The visibility level of a bucket. Mirrors the `access_level` enum. */
export type BucketAccessLevel = 'private' | 'public_read';

/** A single bucket on a branch. Mirrors the `Bucket` schema. */
export type Bucket = {
  /** The bucket name (DNS-safe, unique within the branch). */
  name: string;
  /** Whether the bucket is private or publicly readable. */
  access_level: BucketAccessLevel;
};

/** Response body of the create-bucket endpoint. Mirrors `BucketResponse`. */
export type BucketResponse = {
  /** The bucket that was created. */
  bucket: Bucket;
};

/** Response body of the list-buckets endpoint. Mirrors `BucketsListResponse`. */
export type BucketsListResponse = {
  /** The buckets on the branch. */
  buckets: Bucket[];
};

/** Request body of the create-bucket endpoint. Mirrors `BucketCreateRequest`. */
export type BucketCreateRequest = {
  /** The bucket name to create. */
  name: string;
  /** The visibility level. Defaults to `private` server-side when omitted. */
  access_level?: BucketAccessLevel;
};

/** A single object stored in a bucket. Mirrors the `BucketObject` schema. */
export type BucketObject = {
  /** The full object key. */
  key: string;
  /** The object size in bytes. */
  size: number;
  /** The time the object was last modified (RFC 3339). */
  last_modified: string;
  /** The object's entity tag (content hash). */
  etag: string;
};

/**
 * Response body of the list-objects endpoint. Mirrors
 * `BucketObjectsListResponse`.
 */
export type BucketObjectsListResponse = {
  /**
   * Common prefixes (folder names) collapsed under the requested delimiter.
   * Empty when no delimiter was supplied.
   */
  folders: string[];
  /** Objects whose keys did not collapse into a folder. */
  objects: BucketObject[];
  /** The prefix that was applied to this listing (echoed back). */
  prefix: string;
  /**
   * Pagination cursor to pass as `cursor` on the next request. Empty when the
   * listing is not truncated.
   */
  next_cursor?: string;
  /** True when more results exist beyond this page. */
  is_truncated: boolean;
};

/**
 * Response body of the delete-by-prefix endpoint. Mirrors
 * `BucketObjectsDeletePrefixResponse`.
 */
export type BucketObjectsDeletePrefixResponse = {
  /** The number of objects soft-deleted under the prefix. */
  deleted: number;
};

/** Request body of the presign-upload endpoint. */
export type PresignUploadRequest = {
  /** The Content-Type to sign into the upload (echoed back in `headers`). */
  content_type?: string;
  /** How long the presigned URL stays valid. Server default applies when omitted. */
  expires_in_seconds?: number;
};

/**
 * Response body of the presign-upload endpoint. Mirrors B's
 * `PresignUploadResponse` schema.
 */
export type PresignUploadResponse = {
  /** The presigned URL to PUT the object bytes to. */
  url: string;
  /** Always `PUT` for the single-PUT upload path. */
  method: 'PUT';
  /** Headers that must be sent verbatim with the PUT for the signature to verify. */
  headers: Record<string, string>;
  /** When the presigned URL expires (RFC 3339). */
  expires_at: string;
};

export type ListObjectsParams = {
  projectId: string;
  branchId: string;
  bucketName: string;
  /** Only list objects whose key starts with this prefix. */
  prefix?: string;
  /** Collapse keys sharing a common prefix into the `folders` array. */
  delimiter?: string;
  /** Opaque pagination cursor returned as `next_cursor` by a previous call. */
  cursor?: string;
  /** Maximum number of items (objects + folders) to return. */
  limit?: number;
};

const bucketsPath = (projectId: string, branchId: string) =>
  `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(
    branchId,
  )}/buckets`;

const bucketPath = (projectId: string, branchId: string, bucketName: string) =>
  `${bucketsPath(projectId, branchId)}/${encodeURIComponent(bucketName)}`;

/**
 * Create a bucket on a branch.
 *
 * @request POST /projects/{project_id}/branches/{branch_id}/buckets
 */
export const createProjectBranchBucket = (
  apiClient: ApiClient,
  {
    projectId,
    branchId,
    name,
    accessLevel,
  }: {
    projectId: string;
    branchId: string;
    name: string;
    accessLevel?: BucketAccessLevel;
  },
): Promise<ApiResponse<BucketResponse>> => {
  const body: BucketCreateRequest = { name };
  // Omit access_level entirely so the server default (`private`) applies.
  if (accessLevel !== undefined) {
    body.access_level = accessLevel;
  }
  return apiClient.request<BucketResponse>({
    path: bucketsPath(projectId, branchId),
    method: 'POST',
    body,
    format: 'json',
    secure: true,
  });
};

/**
 * List the buckets on a branch.
 *
 * @request GET /projects/{project_id}/branches/{branch_id}/buckets
 */
export const listProjectBranchBuckets = (
  apiClient: ApiClient,
  { projectId, branchId }: { projectId: string; branchId: string },
): Promise<ApiResponse<BucketsListResponse>> =>
  apiClient.request<BucketsListResponse>({
    path: bucketsPath(projectId, branchId),
    method: 'GET',
    format: 'json',
    secure: true,
  });

/**
 * Delete a bucket from a branch.
 *
 * @request DELETE /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}
 */
export const deleteProjectBranchBucket = (
  apiClient: ApiClient,
  {
    projectId,
    branchId,
    bucketName,
  }: { projectId: string; branchId: string; bucketName: string },
): Promise<ApiResponse<undefined>> =>
  apiClient.request<undefined>({
    path: bucketPath(projectId, branchId, bucketName),
    method: 'DELETE',
    secure: true,
  });

/**
 * List objects (and collapsed folders) in a bucket on a branch.
 *
 * @request GET /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}/objects
 */
export const listProjectBranchBucketObjects = (
  apiClient: ApiClient,
  { projectId, branchId, bucketName, ...query }: ListObjectsParams,
): Promise<ApiResponse<BucketObjectsListResponse>> =>
  apiClient.request<BucketObjectsListResponse>({
    path: `${bucketPath(projectId, branchId, bucketName)}/objects`,
    method: 'GET',
    query,
    format: 'json',
    secure: true,
  });

/**
 * Download an object's raw bytes from a bucket on a branch.
 *
 * The server returns the body as `application/octet-stream` with a
 * `Content-Disposition: attachment` header; the helper requests the body as a
 * stream (`responseType: 'stream'`), so `.data` is a Node `Readable` the caller
 * can pipe straight to disk without buffering the whole object in memory. The
 * response headers are returned alongside so the caller can derive a filename
 * from `Content-Disposition`.
 *
 * The object key may contain `/`; it is percent-encoded into a single path
 * segment so nested keys are routed to the `{object_key}` parameter.
 *
 * @request GET /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}/objects/{object_key}/download
 */
export const getProjectBranchBucketObject = (
  apiClient: ApiClient,
  {
    projectId,
    branchId,
    bucketName,
    objectKey,
  }: {
    projectId: string;
    branchId: string;
    bucketName: string;
    objectKey: string;
  },
): Promise<ApiResponseWithHeaders<Readable>> =>
  apiClient.request<Readable>({
    path: `${bucketPath(projectId, branchId, bucketName)}/objects/${encodeURIComponent(
      objectKey,
    )}/download`,
    method: 'GET',
    format: 'stream',
    secure: true,
  }) as Promise<ApiResponseWithHeaders<Readable>>;

/**
 * Delete an object from a bucket on a branch.
 *
 * The object key may contain `/`; it is percent-encoded into a single path
 * segment so nested keys are routed to the `{object_key}` parameter.
 *
 * @request DELETE /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}/objects/{object_key}
 */
export const deleteProjectBranchBucketObject = (
  apiClient: ApiClient,
  {
    projectId,
    branchId,
    bucketName,
    objectKey,
  }: {
    projectId: string;
    branchId: string;
    bucketName: string;
    objectKey: string;
  },
): Promise<ApiResponse<undefined>> =>
  apiClient.request<undefined>({
    path: `${bucketPath(projectId, branchId, bucketName)}/objects/${encodeURIComponent(
      objectKey,
    )}`,
    method: 'DELETE',
    secure: true,
  });

/**
 * Delete every object under a key prefix (folder) in a bucket on a branch.
 *
 * `prefix` must be non-empty and end with `/`; every object on this branch
 * whose key starts with the prefix is soft-deleted in a single call.
 *
 * @request DELETE /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}/objects-by-prefix
 */
export const deleteProjectBranchBucketObjectsByPrefix = (
  apiClient: ApiClient,
  {
    projectId,
    branchId,
    bucketName,
    prefix,
  }: {
    projectId: string;
    branchId: string;
    bucketName: string;
    prefix: string;
  },
): Promise<ApiResponse<BucketObjectsDeletePrefixResponse>> =>
  apiClient.request<BucketObjectsDeletePrefixResponse>({
    path: `${bucketPath(projectId, branchId, bucketName)}/objects-by-prefix`,
    method: 'DELETE',
    query: { prefix },
    format: 'json',
    secure: true,
  });

/**
 * Request a presigned PUT URL for uploading an object to a bucket on a branch.
 *
 * Returns the URL, the headers that must accompany the PUT for the signature to
 * verify, and the expiry. The actual upload (a `PUT` to the returned `url` with
 * the returned `headers` and the file stream) is performed by the caller, NOT
 * through this api-client, since it targets the branch S3 data-plane endpoint
 * rather than the console API. No SigV4 or credential handling happens here.
 *
 * The object key may contain `/`; it is percent-encoded into a single path
 * segment so nested keys are routed to the `{object_key}` parameter.
 *
 * @request POST /projects/{project_id}/branches/{branch_id}/buckets/{bucket_name}/objects/{object_key}/presign-upload
 */
export const presignUpload = (
  apiClient: ApiClient,
  {
    projectId,
    branchId,
    bucketName,
    objectKey,
    contentType,
    expiresInSeconds,
  }: {
    projectId: string;
    branchId: string;
    bucketName: string;
    objectKey: string;
    contentType?: string;
    expiresInSeconds?: number;
  },
): Promise<ApiResponse<PresignUploadResponse>> => {
  const body: PresignUploadRequest = {};
  if (contentType !== undefined) {
    body.content_type = contentType;
  }
  if (expiresInSeconds !== undefined) {
    body.expires_in_seconds = expiresInSeconds;
  }
  return apiClient.request<PresignUploadResponse>({
    path: `${bucketPath(projectId, branchId, bucketName)}/objects/${encodeURIComponent(
      objectKey,
    )}/presign-upload`,
    method: 'POST',
    body,
    format: 'json',
    secure: true,
  });
};
