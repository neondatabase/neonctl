import { request } from 'https';

export type BaseApiCallProps = {
  token: string;
  apiHost: string;
};
export type ApiCallProps = BaseApiCallProps & {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: object;
};
export const apiCall = ({
  apiHost,
  token,
  path,
  body,
  method = 'GET',
}: ApiCallProps) =>
  new Promise<string>((resolve, reject) => {
    const req = request(
      `${apiHost}/api/v1/${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
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
    );
    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
