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

const bucketPath = (projectId: string, branchId: string, bucketName: string) =>
  `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(
    branchId,
  )}/buckets/${encodeURIComponent(bucketName)}`;

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
 * `Content-Disposition: attachment` header; the helper reads the bytes as an
 * `ArrayBuffer` and returns them alongside the response headers so the caller
 * can derive a filename from `Content-Disposition`.
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
): Promise<ApiResponseWithHeaders<ArrayBuffer>> =>
  apiClient.request<ArrayBuffer>({
    path: `${bucketPath(projectId, branchId, bucketName)}/objects/${encodeURIComponent(
      objectKey,
    )}/download`,
    method: 'GET',
    format: 'arraybuffer',
    secure: true,
  }) as Promise<ApiResponseWithHeaders<ArrayBuffer>>;

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
