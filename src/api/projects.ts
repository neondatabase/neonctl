import { apiCall, BaseApiCallProps } from './gateway';

export const listProjects = async (props: BaseApiCallProps) =>
  apiCall({ ...props, path: 'projects', method: 'GET' });
