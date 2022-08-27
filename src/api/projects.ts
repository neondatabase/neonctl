import { apiCall, BaseApiCallProps } from './gateway';

export const listProjects = async (props: BaseApiCallProps) =>
  apiCall({ ...props, path: 'projects', method: 'GET' });

type CreateProjectProps = {
  instanceHandle: string;
  platformId: string;
  regionId: string;
};
export const createProject = async (
  props: BaseApiCallProps & CreateProjectProps
) =>
  apiCall({
    ...props,
    body: {
      instance_handle: props.instanceHandle,
      platform_id: props.platformId,
      region_id: props.regionId,
    },
    path: 'projects',
    method: 'POST',
  });
