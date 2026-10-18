import { BadRequestException } from '@nestjs/common';

import { MockIdentity } from '../../../shared/@core';

//the mock login body: { identity: 'manager' | 'courier' }. anything else, a missing body included, is a 400 with the
//two legal values in the message; no normalization, the client sends the key as the enum spells it
export function validateMockLogin(body: any): MockIdentity {
  const identity = body?.identity;
  if (!Object.values(MockIdentity).includes(identity)) throw new BadRequestException('identity must be manager or courier');
  return identity;
}
