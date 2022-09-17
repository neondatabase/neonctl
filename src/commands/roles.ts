import { CommonProps } from '../types';
import { writeOut } from '../writer';
import { resetPassword } from '../api/roles';

export type RoleApiCallProps = {
  role_name: string;
  project_id: string;
};

export const resetPwd = async (props: CommonProps & RoleApiCallProps) => {
  writeOut(props)(await resetPassword(props), { fields: [] });
};
