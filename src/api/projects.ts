import { apiCall, BaseApiCallProps } from './gateway';

export type OperationApiCallProps = {
  project_id: string;
  operation_id: string;
};

type Operation = {
  status: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// wait 20 sec max.
export const waitOperationFinalState = async (
  props: BaseApiCallProps & OperationApiCallProps
) => {
  for (let i = 0; i < 100; i++) {
    const operation: Operation = <Operation>await getOperation({ ...props });
    if (operation.status == 'finished') {
      return;
    }
    await sleep(200);
  }
  throw Error(`timeout while waiting for operation ${props.operation_id}`);
};

export const getOperation = (props: BaseApiCallProps & OperationApiCallProps) =>
  apiCall({
    ...props,
    path: `projects/${props.project_id}/operations/${props.operation_id}`,
    method: 'GET',
  });

export type RoleApiCallProps = {
  role_name: string;
  project_id: string;
};

type DSNResponse = {
  dsn: string;
  operation_id: string;
};

export const resetPassword = async (
  props: BaseApiCallProps & RoleApiCallProps
) => {
  const response: DSNResponse = <DSNResponse>await apiCall({
    ...props,
    path: `projects/${props.project_id}/roles/${props.role_name}/reset_password`,
    method: 'POST',
  });
  await waitOperationFinalState({ ...props, ...response });
  return response;
};

export const listProjects = (props: BaseApiCallProps) =>
  apiCall({ ...props, path: 'projects', method: 'GET' });

type CreateProjectProps = {
  settings: unknown;
  name?: string;
};
type CreateProjectResponse = {
  id: string;
  name: string;
  region_name: string;
  created_at: string;
};
export const createProject = (props: BaseApiCallProps & CreateProjectProps) =>
  apiCall({
    ...props,
    body: {
      project: {
        settings: props.settings,
        name: props.name,
      },
    },
    path: 'projects',
    method: 'POST',
  }) as Promise<CreateProjectResponse>;
