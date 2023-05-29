import { ProjectCreateRequest } from '@neondatabase/api-client';
import { CommonProps } from '../types';
import { writeOut } from '../writer';

const PROJECT_FIELDS = ['id', 'name', 'region_id', 'created_at'] as const;

export const list = async (props: CommonProps) => {
  writeOut(props)((await props.apiClient.listProjects({})).data.projects, {
    fields: PROJECT_FIELDS,
  });
};

export const create = async (props: CommonProps & ProjectCreateRequest) => {
  writeOut(props)(
    (
      await props.apiClient.createProject({
        project: props.project,
      })
    ).data.project,
    { fields: PROJECT_FIELDS }
  );
};

export const deleteProject = async (
  props: CommonProps & { project: { id: string } }
) => {
  writeOut(props)(
    (await props.apiClient.deleteProject(props.project.id)).data.project,
    {
      fields: PROJECT_FIELDS,
    }
  );
};

export const update = async (
  props: CommonProps & { project: { id: string } } & ProjectCreateRequest
) => {
  writeOut(props)(
    (
      await props.apiClient.updateProject(props.project.id, {
        project: props.project,
      })
    ).data.project,
    { fields: PROJECT_FIELDS }
  );
};
