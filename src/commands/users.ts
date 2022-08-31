import { CommonProps } from '../types';
import { apiMe } from '../api/users';

export const me = async (props: CommonProps) => {
  process.stdout.write(await apiMe(props));
};
