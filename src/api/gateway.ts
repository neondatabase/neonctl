import { request } from 'https';

export type BaseApiCallProps = {
  token: string;
  apiHost: string;
};
export type ApiCallProps = BaseApiCallProps & {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
};
export const apiCall = ({
  apiHost,
  token,
  path,
  method = 'GET',
}: ApiCallProps) =>
  new Promise<string>((resolve, reject) => {
    request(
      `${apiHost}/api/v1/${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        method,
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`${res.statusCode}: ${res.statusMessage}`));
          return;
        }
        let result = '';
        res.on('data', (data) => {
          result += data;
        });
        res.on('end', () => {
          resolve(result);
        });
      }
    )
      .on('error', reject)
      .end();
  });
