import { CommonProps } from '../types';
import { apiMe } from '../api/users';
import { writeOut } from '../writer';

export const me = async (props: CommonProps) => {
  writeOut(props)(await apiMe(props), {
    fields: ['login', 'email', 'name', 'projects_limit'],
  });
};
