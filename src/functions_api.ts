import { ContentType } from '@neondatabase/api-client';
import { CommonProps } from './types.js';

export type DeploymentStatus = 'pending' | 'building' | 'completed' | 'failed';

export type NeonFunctionDeployment = {
  id: number;
  status: DeploymentStatus;
  memory_mib: number;
  runtime: string;
  created_at: string;
  environment?: Record<string, string>;
};

export type NeonFunction = {
  id: string;
  slug: string;
  name: string;
  invocation_url: string;
  created_at: string;
  active_deployment?: NeonFunctionDeployment;
};

type ApiClient = CommonProps['apiClient'];

const functionsPath = (projectId: string, branchId: string) =>
  `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(
    branchId,
  )}/functions`;

export const listFunctions = async (
  apiClient: ApiClient,
  projectId: string,
  branchId: string,
): Promise<NeonFunction[]> => {
  const { data } = await apiClient.request<{ functions: NeonFunction[] }>({
    path: functionsPath(projectId, branchId),
    method: 'GET',
    secure: true,
    format: 'json',
  });
  return data.functions;
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
  memoryMib: number;
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
  form.append('memory_mib', String(params.memoryMib));
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
