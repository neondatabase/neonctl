import { createProject, listProjects } from '../api/projects';
import { CommonProps } from '../types';
import { writeOut } from '../writer';

export const list = async (props: CommonProps) => {
  writeOut(props)(await listProjects(props), {
    fields: ['id', 'name', 'region_name', 'created_at'],
  });
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
