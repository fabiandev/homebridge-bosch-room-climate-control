import { ServiceId } from './ServiceId';
import { StateTypes } from './StateTypes';

export type Service<StateType extends StateTypes = StateTypes> = {
    '@type': 'DeviceServiceData';
    id: ServiceId;
    deviceId: string;
    state: StateType;
    operations: string[];
    path: string;
};