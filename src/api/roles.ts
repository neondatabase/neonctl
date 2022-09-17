import { apiCall, BaseApiCallProps } from './gateway';
import { waitOperationFinalState } from './operations';

export type RoleApiCallProps = {
  role_name: string;
  project_id: string;
};

type DSNResponse = {
  dsn: string;
  operation_id: string;
};

export const resetPassword = async (
  props: BaseApiCallProps & RoleApiCallProps
) => {
  const response = <DSNResponse>await apiCall({
    ...props,
    path: `projects/${props.project_id}/roles/${props.role_name}/reset_password`,
    method: 'POST',
  });
  await waitOperationFinalState({ ...props, ...response });
  return response;
};
