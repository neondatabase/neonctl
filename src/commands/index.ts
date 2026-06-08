import * as auth from './auth.js';
import * as projects from './projects.js';
import * as ipAllow from './ip_allow.js';
import * as vpcEndpoints from './vpc_endpoints.js';
import * as users from './user.js';
import * as orgs from './orgs.js';
import * as branches from './branches.js';
import * as databases from './databases.js';
import * as roles from './roles.js';
import * as operations from './operations.js';
import * as cs from './connection_string.js';
import * as psql from './psql.js';
import * as setContext from './set_context.js';
import * as checkout from './checkout.js';
import * as link from './link.js';
import * as init from './init.js';
import * as dataApi from './data_api.js';
import * as neonAuth from './neon_auth.js';
import * as functions from './functions.js';
import * as dev from './dev.js';
import * as config from './config.js';
import * as deploy from './deploy.js';

export default [
  auth,
  users,
  orgs,
  projects,
  ipAllow,
  vpcEndpoints,
  neonAuth,
  branches,
  databases,
  roles,
  operations,
  cs,
  psql,
  setContext,
  checkout,
  link,
  init,
  dataApi,
  functions,
  dev,
  config,
  deploy,
];
