import { apiCall, BaseApiCallProps } from './gateway';

type User = {
  id: string;
  login: string;
  email: string;
  name: string;
  projects_limit: number;
};

export const apiMe = (props: BaseApiCallProps) =>
  apiCall({
    ...props,
    path: 'users/me',
    method: 'GET',
  }) as Promise<User>;
