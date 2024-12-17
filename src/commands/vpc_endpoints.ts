import { VPCEndpointAssignment } from '@neondatabase/api-client';
import yargs from 'yargs';
import {
  CommonProps,
  ProjectScopeProps,
  OrgScopeProps,
  IdOrNameProps,
} from '../types';
import { writer } from '../writer.js';
import { fillSingleProject, fillSingleOrg } from '../utils/enrichers.js';
import { REGIONS } from './projects.js';
import { log } from '../log.js';

const VPC_ENDPOINT_FIELDS = ['vpc_endpoint_id', 'label'] as const;

const VPC_ENDPOINT_DETAILS_FIELDS = [
  'vpc_endpoint_id',
  'label',
  'state',
  'num_restricted_projects',
  'example_restricted_projects',
] as const;

export const command = 'vpc';
export const describe = 'Manage VPC endpoints and project VPC restrictions';
export const builder = (argv: yargs.Argv) => {
  return argv
    .usage('$0 vpc <sub-command> [options]')
    .command(
      'endpoint',
      'Manage VPC endpoints.\n' +
        'See: https://neon.tech/docs/guides/neon-private-networking\n' +
        'After adding an endpoint to an organization, client connections will be accepted\n' +
        'from the corresponding VPC for all projects in the organization, unless overridden\n' +
        'by a project-level VPC endpoint restriction.',
      (yargs) => {
        return yargs
          .options({
            'org-id': {
              describe: 'Organization ID',
              type: 'string',
            },
            'region-id': {
              describe: `The region ID. Possible values: ${REGIONS.join(', ')}`,
              type: 'string',
              demandOption: true,
            },
          })
          .middleware(fillSingleOrg as any)
          .command(
            'list',
            'List configured VPC endpoints for this organization.',
            (yargs) => yargs,
            async (args) => {
              await listOrg(args as any);
            },
          )
          .command({
            command: 'assign <id>',
            aliases: ['update <id>', 'add <id>'],
            describe:
              'Add or update a VPC endpoint for this organization.\n' +
              'Note: Azure regions are not yet supported.',
            builder: (yargs) =>
              yargs.options({
                label: {
                  describe:
                    'An optional descriptive label for the VPC endpoint',
                  type: 'string',
                },
              }),
            handler: async (args) => {
              await assignOrg(args as any);
            },
          })
          .command(
            'remove <id>',
            'Remove a VPC endpoint from this organization.',
            (yargs) => yargs,
            async (args) => {
              await removeOrg(args as any);
            },
          )
          .command(
            'status <id>',
            'Get the status of a VPC endpoint for this organization.',
            (yargs) => yargs,
            async (args) => {
              await statusOrg(args as any);
            },
          );
      },
    )
    .command(
      'project',
      'Manage project-level VPC endpoint restrictions.\n' +
        'By default, connections are accepted from any VPC configured at the organization level.\n' +
        'A project-level VPC endpoint restriction can be used to restrict connections to a specific VPC.',
      (yargs) => {
        return yargs
          .options({
            'project-id': {
              describe: 'Project ID',
              type: 'string',
            },
          })
          .middleware(fillSingleProject as any)
          .command(
            'list',
            'List VPC endpoint restrictions for this project.',
            (yargs) => yargs,
            async (args) => {
              await listProject(args as any);
            },
          )
          .command({
            command: 'restrict <id>',
            aliases: ['update <id>'],
            describe:
              'Configure or update a VPC endpoint restriction for this project.',
            builder: (yargs) =>
              yargs.options({
                label: {
                  describe:
                    'An optional descriptive label for the VPC endpoint restriction',
                  type: 'string',
                },
              }),
            handler: async (args) => {
              await assignProject(args as any);
            },
          })
          .command(
            'remove <id>',
            'Remove a VPC endpoint restriction from this project.',
            (yargs) => yargs,
            async (args) => {
              await removeProject(args as any);
            },
          );
      },
    );
};

const listOrg = async (
  props: CommonProps & OrgScopeProps & { regionId: string },
) => {
  const { data } = await props.apiClient.listOrganizationVpcEndpoints(
    props.orgId,
    props.regionId,
  );
  writer(props).end(data.endpoints, {
    fields: VPC_ENDPOINT_FIELDS,
  });
};

const assignOrg = async (
  props: CommonProps &
    OrgScopeProps &
    IdOrNameProps & { regionId: string; label?: string },
) => {
  const vpcEndpointAssignment: VPCEndpointAssignment = {
    label: props.label || '',
  };
  const { data } = await props.apiClient.assignOrganizationVpcEndpoint(
    props.orgId,
    props.regionId,
    props.id,
    vpcEndpointAssignment,
  );
  writer(props).end(data, { fields: [] });

  if (props.regionId.startsWith('azure')) {
    log.info('VPC endpoint configuration is not supported for Azure regions');
  }
};

const removeOrg = async (
  props: CommonProps & OrgScopeProps & IdOrNameProps & { regionId: string },
) => {
  const { data } = await props.apiClient.deleteOrganizationVpcEndpoint(
    props.orgId,
    props.regionId,
    props.id,
  );
  writer(props).end(data, { fields: [] });
};

const statusOrg = async (
  props: CommonProps & OrgScopeProps & IdOrNameProps & { regionId: string },
) => {
  const { data } = await props.apiClient.getOrganizationVpcEndpointDetails(
    props.orgId,
    props.regionId,
    props.id,
  );
  writer(props).end(data, { fields: VPC_ENDPOINT_DETAILS_FIELDS });
};

const listProject = async (props: CommonProps & ProjectScopeProps) => {
  const { data } = await props.apiClient.listProjectVpcEndpoints(
    props.projectId,
  );
  writer(props).end(data.endpoints, {
    fields: VPC_ENDPOINT_FIELDS,
  });
};

const assignProject = async (
  props: CommonProps & ProjectScopeProps & IdOrNameProps & { label?: string },
) => {
  const vpcEndpointAssignment: VPCEndpointAssignment = {
    label: props.label || '',
  };
  const { data } = await props.apiClient.assignProjectVpcEndpoint(
    props.projectId,
    props.id,
    vpcEndpointAssignment,
  );
  writer(props).end(data, { fields: [] });
};

const removeProject = async (
  props: CommonProps & ProjectScopeProps & IdOrNameProps,
) => {
  const { data } = await props.apiClient.deleteProjectVpcEndpoint(
    props.projectId,
    props.id,
  );
  writer(props).end(data, { fields: [] });
};
