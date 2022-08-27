import { listProjects } from '../api/projects';

export type ProjectsProps = {
  token: string;
  apiHost: string;
};

export default async (props: ProjectsProps) => {
  process.stdout.write(await listProjects(props));
};
