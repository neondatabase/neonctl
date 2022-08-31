import { request } from 'node:https';
import { IncomingMessage } from 'node:http';

export class ApiError extends Error {
  constructor(public response: IncomingMessage) {
    super(response.statusMessage);
  }

  async getApiError() {
    return new Promise((resolve, reject) => {
      const data: string[] = [];
      this.response
        .on('data', (chunk) => {
          data.push(chunk);
        })
        .on('end', () => {
          try {
            const json = JSON.parse(data.join(''));
            resolve(
              json?.message ||
                `${this.response.statusCode}:${this.message}:${data.join('')}`
            );
          } catch (e) {
            reject(e);
          }
        })
        .on('error', (e) => {
          reject(e);
        });
    });
  }
}

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
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new ApiError(res));
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
