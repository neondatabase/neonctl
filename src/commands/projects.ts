import { createProject, listProjects } from '../api/projects';
import { CommonProps } from '../types';

export const list = async (props: CommonProps) => {
  process.stdout.write(await listProjects(props));
};

export type ProjectCreateProps = {
  name?: string;
};
export const create = async (props: CommonProps & ProjectCreateProps) => {
  process.stdout.write(
    await createProject({
      ...props,
      settings: {},
      name: props.name,
    })
  );
};
