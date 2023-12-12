import { BoschServiceId } from './BoschServiceId';
import { BoschState } from './BoschState';

export type BoschDeviceServiceData<T extends BoschState = BoschState> = {
    '@type': 'DeviceServiceData';
    id: BoschServiceId;
    deviceId: string;
    state: T;
    operations?: string[];
    path: string;
};