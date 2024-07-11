import * as auth from './auth.js';
import * as projects from './projects.js';
import * as ipAllow from './ip_allow.js';
import * as users from './user.js';
import * as orgs from './orgs.js';
import * as branches from './branches.js';
import * as databases from './databases.js';
import * as roles from './roles.js';
import * as operations from './operations.js';
import * as cs from './connection_string.js';
import * as setContext from './set_context.js';
import * as bootstrap from './bootstrap/index.js';

export default [
  auth,
  users,
  orgs,
  projects,
  ipAllow,
  branches,
  databases,
  roles,
  operations,
  cs,
  setContext,
  bootstrap,
];
