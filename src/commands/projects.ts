import { createProject, listProjects, resetPassword } from '../api/projects';
import { CommonProps } from '../types';
import { writeOut } from '../writer';

export type RoleApiCallProps = {
  role_name: string;
  project_id: string;
};

export const resetPwd = async (props: CommonProps & RoleApiCallProps) => {
  writeOut(props)(await resetPassword(props), { fields: [] });
};

export const list = async (props: CommonProps) => {
  writeOut(props)(await listProjects(props), { fields: [] });
};

export type ProjectCreateProps = {
  name?: string;
};
export const create = async (props: CommonProps & ProjectCreateProps) => {
  writeOut(props)(
    await createProject({
      ...props,
      settings: {},
      name: props.name,
    }),
    { fields: ['id', 'name', 'region_name', 'created_at'] }
  );
};
