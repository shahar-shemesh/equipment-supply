import { User } from './user.entity';
import { Courier } from './courier.entity';
import { Issuance } from './issuance.entity';
import { IssuanceItem } from './issuance-item.entity';
import { DeliveryTask } from './delivery-task.entity';
import { DeliveryAttempt } from './delivery-attempt.entity';
import { DeliveryAttemptItem } from './delivery-attempt-item.entity';
import { DeliveryOperation } from './delivery-operation.entity';

export { User, Courier, Issuance, IssuanceItem, DeliveryTask, DeliveryAttempt, DeliveryAttemptItem, DeliveryOperation };

export const entities = [User, Courier, Issuance, IssuanceItem, DeliveryTask, DeliveryAttempt, DeliveryAttemptItem, DeliveryOperation];
