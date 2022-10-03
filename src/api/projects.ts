import { apiCall, BaseApiCallProps } from './gateway';

export const listProjects = (props: BaseApiCallProps) =>
  apiCall({
    ...props,
    path: 'projects',
    method: 'GET',
  }) as Promise<CreateProjectResponse>;

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
