import { createProject, listProjects } from '../api/projects';

export type ProjectsProps = {
  token: string;
  apiHost: string;
  sub?: 'list' | 'create';
};

export default async (props: ProjectsProps) => {
  if (props.sub === 'list' || props.sub === undefined) {
    process.stdout.write(await listProjects(props));
  } else if (props.sub === 'create') {
    process.stdout.write(
      await createProject({
        ...props,
        settings: {},
      })
    );
  }
};
