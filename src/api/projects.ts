import { apiCall, BaseApiCallProps } from './gateway';

export const listProjects = (props: BaseApiCallProps) =>
  apiCall({ ...props, path: 'projects', method: 'GET' });

type CreateProjectProps = {
  settings: unknown;
  name?: string;
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
  });
