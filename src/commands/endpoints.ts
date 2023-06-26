import {
  EndpointCreateRequest,
  EndpointUpdateRequest,
} from '@neondatabase/api-client';
import yargs from 'yargs';
import { retryOnLock } from '../api.js';
import {
  endpointCreateRequest,
  endpointUpdateRequest,
} from '../parameters.gen.js';
import { BranchScopeProps, EndpointScopeProps } from '../types.js';
import { commandFailHandler } from '../utils.js';
import { writer } from '../writer.js';

const ENDPOINT_FIELDS = [
  'id',
  'created_at',
  'branch_id',
  'type',
  'current_state',
] as const;

export const command = 'endpoints';
export const describe = 'Manage endpoints';
export const aliases = ['endpoint'];
export const builder = (argv: yargs.Argv) =>
  argv
    .demandCommand(1, '')
    .fail(commandFailHandler)
    .usage('usage: $0 endpoints <sub-command> [options]')
    .options({
      'project.id': {
        describe: 'Project ID',
        type: 'string',
        demandOption: true,
      },
    })
    .command(
      'list',
      'List endpoints',
      (yargs) =>
        yargs.options({
          'branch.id': {
            describe: 'Branch ID',
            type: 'string',
            demandOption: false,
          },
        }),
      async (args) => await list(args as any)
    )
    .command(
      'create',
      'Create an endpoint',
      (yargs) => yargs.options(endpointCreateRequest),
      async (args) => await create(args as any)
    )
    .command(
      'update',
      'Update an endpoint',
      (yargs) =>
        yargs.options({
          'endpoint.id': {
            describe: 'Endpoint ID',
            type: 'string',
            demandOption: true,
          },
          ...endpointUpdateRequest,
        }),
      async (args) => await update(args as any)
    )
    .command(
      'delete',
      'Delete an endpoint',
      (yargs) =>
        yargs.options({
          'endpoint.id': {
            describe: 'Endpoint ID',
            type: 'string',
            demandOption: true,
          },
        }),
      async (args) => await deleteEndpoint(args as any)
    )
    .command(
      'get',
      'Get an endpoint',
      (yargs) =>
        yargs.options({
          'endpoint.id': {
            describe: 'Endpoint ID',
            type: 'string',
            demandOption: true,
          },
        }),
      async (args) => await getEndpoint(args as any)
    );

export const handler = async (args: yargs.Argv) => args;

const list = async (props: BranchScopeProps) => {
  const { data } = props.branch?.id
    ? await props.apiClient.listProjectBranchEndpoints(
        props.project.id,
        props.branch.id
      )
    : await props.apiClient.listProjectEndpoints(props.project.id);
  writer(props).end(data.endpoints, {
    fields: ENDPOINT_FIELDS,
  });
};

const create = async (props: BranchScopeProps & EndpointCreateRequest) => {
  const { data } = await retryOnLock(() =>
    props.apiClient.createProjectEndpoint(props.project.id, {
      endpoint: props.endpoint,
    })
  );

  writer(props).end(data.endpoint, {
    fields: ENDPOINT_FIELDS,
  });
};

const update = async (props: EndpointScopeProps & EndpointUpdateRequest) => {
  const { data } = await retryOnLock(() =>
    props.apiClient.updateProjectEndpoint(props.project.id, props.endpoint.id, {
      endpoint: props.endpoint,
    })
  );

  writer(props).end(data.endpoint, {
    fields: ENDPOINT_FIELDS,
  });
};

const deleteEndpoint = async (props: EndpointScopeProps) => {
  const { data } = await retryOnLock(() =>
    props.apiClient.deleteProjectEndpoint(props.project.id, props.endpoint.id)
  );
  writer(props).end(data.endpoint, {
    fields: ENDPOINT_FIELDS,
  });
};

const getEndpoint = async (props: EndpointScopeProps) => {
  const { data } = await props.apiClient.getProjectEndpoint(
    props.project.id,
    props.endpoint.id
  );
  writer(props).end(data.endpoint, {
    fields: ENDPOINT_FIELDS,
  });
};
