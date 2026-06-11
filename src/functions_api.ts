import { ContentType } from '@neondatabase/api-client';
import { CommonProps } from './types.js';

export type DeploymentStatus = 'pending' | 'building' | 'completed' | 'failed';

export type NeonFunctionDeployment = {
  id: number;
  status: DeploymentStatus;
  memory_mib: number;
  runtime: string;
  created_at: string;
  // Env variable NAMES, sorted by the server. Values are write-only and are
  // never returned by the API.
  environment?: string[];
  // Build failure reason; present only when status is 'failed'.
  error?: string;
};

export type NeonFunction = {
  id: string;
  slug: string;
  name: string;
  invocation_url: string;
  created_at: string;
  // The most recent deployment, any build status (may be building or
  // failed). Absent until the first deployment is created.
  current_deployment?: NeonFunctionDeployment;
  // The most recent deployment whose build succeeded; the one serving
  // invocations. A failed build never appears here.
  active_deployment?: NeonFunctionDeployment;
};

type ApiClient = CommonProps['apiClient'];

const functionsPath = (projectId: string, branchId: string) =>
  `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(
    branchId,
  )}/functions`;

export type ListFunctionsPage = {
  functions: NeonFunction[];
  // Cursor of the next page; absent on the last page and on servers
  // that do not paginate.
  next?: string;
};

export const listFunctions = async (
  apiClient: ApiClient,
  projectId: string,
  branchId: string,
  { cursor, limit }: { cursor?: string; limit?: number } = {},
): Promise<ListFunctionsPage> => {
  const { data } = await apiClient.request<{
    functions: NeonFunction[];
    pagination?: { next?: string };
  }>({
    path: functionsPath(projectId, branchId),
    method: 'GET',
    query: { cursor, limit },
    secure: true,
    format: 'json',
  });
  return { functions: data.functions, next: data.pagination?.next };
};

export const getFunction = async (
  apiClient: ApiClient,
  projectId: string,
  branchId: string,
  slug: string,
): Promise<NeonFunction> => {
  const { data } = await apiClient.request<{ function: NeonFunction }>({
    path: `${functionsPath(projectId, branchId)}/${encodeURIComponent(slug)}`,
    method: 'GET',
    secure: true,
    format: 'json',
  });
  return data.function;
};

export const deleteFunction = async (
  apiClient: ApiClient,
  projectId: string,
  branchId: string,
  slug: string,
): Promise<void> => {
  await apiClient.request<unknown>({
    path: `${functionsPath(projectId, branchId)}/${encodeURIComponent(slug)}`,
    method: 'DELETE',
    secure: true,
  });
};

export type DeployParams = {
  zip: Uint8Array;
  runtime: string;
  environment?: string; // JSON-encoded string-to-string map
};

export const createDeployment = async (
  apiClient: ApiClient,
  projectId: string,
  branchId: string,
  slug: string,
  params: DeployParams,
): Promise<void> => {
  const form = new FormData();
  form.append('zip', new Blob([params.zip]), 'bundle.zip');
  form.append('runtime', params.runtime);
  if (params.environment) form.append('environment', params.environment);

  // The deploy POST returns an operation the CLI cannot poll; the body is
  // ignored. We only need the request to succeed.
  await apiClient.request<unknown>({
    path: `${functionsPath(projectId, branchId)}/${encodeURIComponent(
      slug,
    )}/deployments`,
    method: 'POST',
    type: ContentType.FormData,
    body: form,
    secure: true,
  });
};
