import { BoschClimateControlState } from './BoschClimateControlState';
import { BoschServiceId } from './BoschServiceId';
import { BoschState } from './BoschState';
import { BoschTemperatureLevelState } from './BoschTemperatureLevelState';

export type BoschDeviceServiceData<T extends BoschState = BoschState> = {
    '@type': 'DeviceServiceData';
    id: BoschServiceId;
    deviceId: string;
    state: T;
    operations?: string[];
    path: string;
};

export function isRoomClimateControlService(deviceServiceData: BoschDeviceServiceData)
  : deviceServiceData is BoschDeviceServiceData<BoschClimateControlState> {
  if (deviceServiceData.id === BoschServiceId.RoomClimateControl) {
    return true;
  }

  return false;
}

export function isTemperatureLevelService(deviceServiceData: BoschDeviceServiceData)
  : deviceServiceData is BoschDeviceServiceData<BoschTemperatureLevelState> {
  if (deviceServiceData.id === BoschServiceId.TemperatureLevel) {
    return true;
  }

  return false;
}
