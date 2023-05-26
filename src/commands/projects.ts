import { CommonProps } from '../types';
import { writeOut } from '../writer';

export const list = async (props: CommonProps) => {
  writeOut(props)((await props.apiClient.listProjects({})).data.projects, {
    fields: ['id', 'name', 'region_id', 'created_at'],
  });
};

export type ProjectCreateProps = {
  name?: string;
};
export const create = async (props: CommonProps & ProjectCreateProps) => {
  writeOut(props)(
    (
      await props.apiClient.createProject({
        project: {
          name: props.name,
        },
      })
    ).data.project,
    { fields: ['id', 'name', 'region_id', 'created_at'] }
  );
};
