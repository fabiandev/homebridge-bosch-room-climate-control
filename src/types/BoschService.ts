import { BoschServiceId } from './BoschServiceId';
import { BoschState } from './BoschState';

export type BoschService<StateType extends BoschState = BoschState> = {
    '@type': 'DeviceServiceData';
    id: BoschServiceId;
    deviceId: string;
    state: StateType;
    operations: string[];
    path: string;
};