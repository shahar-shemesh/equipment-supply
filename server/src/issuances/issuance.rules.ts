import { ConflictException } from '@nestjs/common';

import { IssuanceStatus } from '../../../shared/@core';
import { IssuanceAction, canDo } from '../../../shared/@rules';

//the table itself lives in shared/@rules.ts so the manager board disables what this file refuses. this side adds the 409
export { allowedFrom, canDo, editableStatuses } from '../../../shared/@rules';
export type { IssuanceAction } from '../../../shared/@rules';

/*──────────────────────────────────────────────────────────────────────────*/

//the body keeps the english message (the e2e specs match on it) and names the parts next to it, so the client can
//word the refusal in hebrew without parsing the sentence
export function assertCanDo(action: IssuanceAction, issuance: { sap_number: string; status: IssuanceStatus }) {
  if (canDo(action, issuance.status)) return;
  throw new ConflictException({
    statusCode: 409,
    message: `issuance ${issuance.sap_number} is ${issuance.status}, ${action} is not allowed`,
    code: 'status_not_allowed',
    sap_number: issuance.sap_number,
    status: issuance.status,
    action,
  });
}
