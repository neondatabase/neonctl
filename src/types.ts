import { Api } from '@neondatabase/api-client';

export type CommonProps = {
  apiClient: Api<unknown>;
  apiKey: string;
  apiHost: string;
  output: string;
};
