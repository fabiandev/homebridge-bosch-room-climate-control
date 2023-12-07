import { BoschOperationMode } from './BoschOperationMode';
import { BoschRoomControlMode } from './BoschRoomControlMode';

export type BoschClimateControlState = {
    '@type': 'climateControlState';
    operationMode: BoschOperationMode;
    setpointTemperature: number;
    setpointTemperatureForLevelEco: number;
    setpointTemperatureForLevelComfort: number;
    schedule: object; // types not needed currently
    ventilationMode: boolean;
    low: boolean;
    boostMode: boolean;
    summerMode: boolean;
    supportsBoostMode: boolean;
    roomControlMode: BoschRoomControlMode;
    activeScheduleId: string;
    setPointTemperatureOffset: number;
    isSetPointTemperatureOffsetActive: false;
    setPointTemperatureOffsetActiveValue: number;
};
