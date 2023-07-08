import { Api } from '@neondatabase/api-client';

export type CommonProps = {
  apiClient: Api<unknown>;
  apiKey: string;
  apiHost: string;
  output: 'yaml' | 'json' | 'table';
};

export type ProjectScopeProps = CommonProps & {
  projectId: string;
};

export type IdOrNameProps = {
  id: string;
};

export type BranchScopeProps = ProjectScopeProps &
  (
    | {
        branch: string;
      }
    | IdOrNameProps
  );
