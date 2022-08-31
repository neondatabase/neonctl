import { apiCall, BaseApiCallProps } from './gateway';

export const apiMe = (props: BaseApiCallProps) =>
  apiCall({
    ...props,
    path: 'users/me',
    method: 'GET',
  });
