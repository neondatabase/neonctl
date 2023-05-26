import { CommonProps } from '../types';
import { writeOut } from '../writer';

export const me = async (props: CommonProps) => {
  writeOut(props)((await props.apiClient.getCurrentUserInfo()).data, {
    fields: ['login', 'email', 'name', 'projects_limit'],
  });
};
