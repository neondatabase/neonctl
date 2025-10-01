import { TokenEndpointResponse } from 'openid-client';
import { ExtendedTokenSet } from '../types';

export const extendTokenSet = (
  tokenSet: TokenEndpointResponse,
): ExtendedTokenSet => {
  const exp = new Date();
  exp.setSeconds(exp.getSeconds() + (tokenSet.expires_in ?? 0));
  return { ...tokenSet, expires_at: exp.getTime() };
};
