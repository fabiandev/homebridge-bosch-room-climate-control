import { OperationMode } from './OperationMode';
import { RoomControlMode } from './RoomControlMode';

export type ClimateControlState = {
    '@type': 'climateControlState';
    operationMode: OperationMode;
    setpointTemperature: number;
    setpointTemperatureForLevelEco: number;
    setpointTemperatureForLevelComfort: number;
    schedule: object; // types not needed currently
    ventilationMode: boolean;
    low: boolean;
    boostMode: boolean;
    summerMode: boolean;
    supportsBoostMode: boolean;
    roomControlMode: RoomControlMode;
    activeScheduleId: string;
    setPointTemperatureOffset: number;
    isSetPointTemperatureOffsetActive: false;
    setPointTemperatureOffsetActiveValue: number;
};
