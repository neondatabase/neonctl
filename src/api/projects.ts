import { apiCall, BaseApiCallProps } from './gateway';

export const listProjects = async (props: BaseApiCallProps) =>
  apiCall({ ...props, path: 'projects', method: 'GET' });

type CreateProjectProps = {
  settings: unknown;
};
export const createProject = (props: BaseApiCallProps & CreateProjectProps) =>
  apiCall({
    ...props,
    body: {
      project: {
        settings: props.settings,
      },
    },
    path: 'projects',
    method: 'POST',
  });
