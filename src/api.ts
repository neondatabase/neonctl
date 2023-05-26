import { createApiClient } from '@neondatabase/api-client';
import { AxiosResponse } from 'axios';

export type ApiCallProps = {
  apiKey: string;
  apiHost?: string;
};

export const getApiClient = ({ apiKey, apiHost }: ApiCallProps) =>
  createApiClient({ apiKey, baseURL: apiHost });

export type ApiError = {
  response: AxiosResponse;
};

export const isApiError = (err: unknown): err is ApiError =>
  err instanceof Error && 'response' in err;
